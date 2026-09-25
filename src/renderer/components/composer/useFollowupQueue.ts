import { useCallback, useEffect, useRef, useState } from 'react'

import { cacheService } from '@data/CacheService'
import type { ComposerQueuedMessagePayload } from '@shared/ai/transport'

import type { ComposerSerializedDraft } from './tokens'

export interface FollowupQueueItem {
  id: string
  /** Serialized draft (text + tokens) — drives the dock preview and edit-restore. */
  draft: ComposerSerializedDraft
  /** Send-ready payload (text + parts + files/models) captured at enqueue time. */
  payload: ComposerQueuedMessagePayload
}

/** Same per-window memory tier + TTL as the inputbar draft cache (`composerDraft` / ChatComposer). */
const QUEUE_TTL = 24 * 60 * 60 * 1000
const keyFor = (scopeKey: string) => `followup-queue.${scopeKey}`
const pausedKeyFor = (scopeKey: string) => `followup-queue-paused.${scopeKey}`

/** Restart-safe mirror of every scope's queue (localStorage-backed persist tier). A queued message
 *  is user input the user expects to be sent, so it must survive quitting and reopening the app. */
const PERSISTED_QUEUES_KEY = 'ui.composer.followup_queues'
const PERSISTED_QUEUE_TTL = 7 * 24 * 60 * 60 * 1000

type PersistedQueueEntry = { items: unknown[]; paused: boolean; updatedAt: number }

function loadPersistedEntry(scopeKey: string): PersistedQueueEntry | undefined {
  const entry = cacheService.getPersist(PERSISTED_QUEUES_KEY)?.[scopeKey]
  if (!entry || Date.now() - entry.updatedAt > PERSISTED_QUEUE_TTL) return undefined
  return entry
}

function savePersistedEntry(scopeKey: string, patch: { items?: FollowupQueueItem[]; paused?: boolean }): void {
  cacheService.setPersist(PERSISTED_QUEUES_KEY, (prev) => {
    const now = Date.now()
    const next: Record<string, PersistedQueueEntry> = {}
    for (const [key, entry] of Object.entries(prev ?? {})) {
      if (key !== scopeKey && now - entry.updatedAt <= PERSISTED_QUEUE_TTL) next[key] = entry
    }
    const current = prev?.[scopeKey]
    const items = patch.items ?? current?.items ?? []
    const paused = patch.paused ?? current?.paused ?? false
    // Drop empty, unpaused scopes so the stored blob only holds queues that still matter.
    if (items.length > 0 || paused) next[scopeKey] = { items: [...items], paused, updatedAt: now }
    return next
  })
}

/** Load + validate a queue: this window's memory cache first, then the restart-safe copy (the
 *  caches hold arbitrary JSON; guard non-array entries). */
function loadQueue(scopeKey: string): FollowupQueueItem[] {
  const cached = cacheService.getCasual<FollowupQueueItem[]>(keyFor(scopeKey))
  if (Array.isArray(cached)) return cached
  const persisted = loadPersistedEntry(scopeKey)?.items
  return Array.isArray(persisted) ? (persisted as FollowupQueueItem[]) : []
}

function loadPaused(scopeKey: string): boolean {
  const cached = cacheService.getCasual<boolean>(pausedKeyFor(scopeKey))
  if (typeof cached === 'boolean') return cached
  return loadPersistedEntry(scopeKey)?.paused === true
}

interface UseFollowupQueueParams {
  /** Per-conversation key — same `${topicId}:${assistantId}` scope as the draft cache. */
  scopeKey: string
  /** `done`-and-unacknowledged edge from `useTopicStreamStatus` — the live→idle drain trigger. */
  isFulfilled: boolean
  /** Acknowledge the completion so the drain fires once per turn. */
  markSeen: () => void
  /** Send a payload (busy → backend steer; idle → normal send). Resolves to whether it was sent. */
  onDrain: (payload: ComposerQueuedMessagePayload) => Promise<boolean>
  /** Called when auto-drain fails and leaves the queued item in place. */
  onDrainFailed?: () => void
}

export interface FollowupQueueController {
  items: FollowupQueueItem[]
  enqueue: (draft: ComposerSerializedDraft, payload: ComposerQueuedMessagePayload) => void
  removeId: (id: string) => void
  reorder: (nextItems: FollowupQueueItem[]) => void
  paused: boolean
  setPaused: (paused: boolean) => void
}

/**
 * Per-conversation FIFO queue of follow-up drafts. While a turn streams the composer enqueues here
 * instead of sending; on the live→idle edge the head auto-drains (one per completion), and the dock
 * lets the user steer/edit/remove individual items or pause auto-drain. Each change is written to
 * the per-window memory cache (same tier + TTL as the draft cache) and mirrored to the persist tier,
 * so a queue survives an app restart and reloads from there when the window cache is empty.
 */
export function useFollowupQueue({
  scopeKey,
  isFulfilled,
  markSeen,
  onDrain,
  onDrainFailed
}: UseFollowupQueueParams): FollowupQueueController {
  const [items, setItems] = useState<FollowupQueueItem[]>(() => loadQueue(scopeKey))
  const [paused, setPausedState] = useState(() => loadPaused(scopeKey))

  // Latest values for the persistence + drain closures (kept off the effect deps to avoid re-running).
  const scopeKeyRef = useRef(scopeKey)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const onDrainRef = useRef(onDrain)
  onDrainRef.current = onDrain
  const onDrainFailedRef = useRef(onDrainFailed)
  onDrainFailedRef.current = onDrainFailed

  const persist = useCallback((next: FollowupQueueItem[]) => {
    cacheService.setCasual(keyFor(scopeKeyRef.current), next, QUEUE_TTL)
    savePersistedEntry(scopeKeyRef.current, { items: next })
  }, [])

  // Reload when switching conversations; the previous queue stays in its own scoped cache entry.
  useEffect(() => {
    if (scopeKeyRef.current === scopeKey) return
    scopeKeyRef.current = scopeKey
    setItems(loadQueue(scopeKey))
    setPausedState(loadPaused(scopeKey))
  }, [scopeKey])

  const setPaused = useCallback((nextPaused: boolean) => {
    cacheService.setCasual(pausedKeyFor(scopeKeyRef.current), nextPaused)
    savePersistedEntry(scopeKeyRef.current, { paused: nextPaused })
    setPausedState(nextPaused)
  }, [])

  const enqueue = useCallback(
    (draft: ComposerSerializedDraft, payload: ComposerQueuedMessagePayload) => {
      setItems((prev) => {
        const next = [...prev, { id: crypto.randomUUID(), draft, payload }]
        persist(next)
        return next
      })
    },
    [persist]
  )

  const removeId = useCallback(
    (id: string) => {
      setItems((prev) => {
        const next = prev.filter((item) => item.id !== id)
        persist(next)
        return next
      })
    },
    [persist]
  )

  const reorder = useCallback(
    (nextItems: FollowupQueueItem[]) => {
      setItems(nextItems)
      persist(nextItems)
    },
    [persist]
  )

  // Drain one message per completion: on the live→idle edge, acknowledge it (so it fires once) and
  // send the head; on success dequeue. The next send goes busy→idle again and drains the next item.
  useEffect(() => {
    if (!isFulfilled || paused) return
    const head = itemsRef.current[0]
    if (!head) return
    markSeen()
    const reportDrainFailure = () => onDrainFailedRef.current?.()
    void onDrainRef.current(head.payload).then((sent) => {
      if (sent) removeId(head.id)
      else reportDrainFailure()
    }, reportDrainFailure)
  }, [isFulfilled, paused, markSeen, removeId])

  return { items, enqueue, removeId, reorder, paused, setPaused }
}
