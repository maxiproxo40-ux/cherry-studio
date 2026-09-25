import type { FC } from 'react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Textarea } from '@cherrystudio/ui'
import { usePreference } from '@data/hooks/usePreference'
import {
  SettingDescription,
  SettingDivider,
  SettingGroup,
  SettingRow,
  SettingRowTitle,
  SettingTitle
} from '@renderer/components/SettingsPrimitives'
import { useTheme } from '@renderer/hooks/useTheme'

const toLines = (values: readonly string[] | null | undefined) => (values ?? []).join('\n')

/** One entry per line; blank lines and duplicates are dropped. */
export function parseLines(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    )
  ]
}

/**
 * Global agent tool-approval allowlist, shared by every agent and project. "Allow always" on a
 * permission prompt adds to the tool list; both lists can be edited here, one entry per line.
 */
const AgentToolApprovalSettings: FC = () => {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const [tools, setTools] = usePreference('agent.tool_approval.always_allowed_tools')
  const [prefixes, setPrefixes] = usePreference('agent.tool_approval.allowed_command_prefixes')
  const [toolsDraft, setToolsDraft] = useState(() => toLines(tools))
  const [prefixesDraft, setPrefixesDraft] = useState(() => toLines(prefixes))

  // Follow outside changes (e.g. "Allow always" clicked on a prompt) while this page is open.
  useEffect(() => setToolsDraft(toLines(tools)), [tools])
  useEffect(() => setPrefixesDraft(toLines(prefixes)), [prefixes])

  return (
    <SettingGroup theme={theme}>
      <SettingTitle>{t('settings.agent.tool_approval.title')}</SettingTitle>
      <SettingDescription className="mt-1.5 leading-5">
        {t('settings.agent.tool_approval.description')}
      </SettingDescription>
      <SettingDivider />
      <SettingRow id="setting-general-agent-always-allowed-tools" className="scroll-mt-6 flex-col items-stretch gap-2">
        <SettingRowTitle id="agent-always-allowed-tools-title">
          {t('settings.agent.tool_approval.tools.label')}
        </SettingRowTitle>
        <SettingDescription className="leading-5">
          {t('settings.agent.tool_approval.tools.description')}
        </SettingDescription>
        <Textarea.Input
          value={toolsDraft}
          rows={4}
          spellCheck={false}
          aria-labelledby="agent-always-allowed-tools-title"
          placeholder={'tool_exec\nmcp__browser__open\nedit'}
          className="resize-y px-3 py-2 font-mono text-xs"
          onValueChange={setToolsDraft}
          onBlur={() => void setTools(parseLines(toolsDraft))}
        />
      </SettingRow>
      <SettingDivider />
      <SettingRow
        id="setting-general-agent-allowed-command-prefixes"
        className="scroll-mt-6 flex-col items-stretch gap-2">
        <SettingRowTitle id="agent-allowed-command-prefixes-title">
          {t('settings.agent.tool_approval.commands.label')}
        </SettingRowTitle>
        <SettingDescription className="leading-5">
          {t('settings.agent.tool_approval.commands.description')}
        </SettingDescription>
        <Textarea.Input
          value={prefixesDraft}
          rows={4}
          spellCheck={false}
          aria-labelledby="agent-allowed-command-prefixes-title"
          placeholder={'git status\ngit diff\nnpm run'}
          className="resize-y px-3 py-2 font-mono text-xs"
          onValueChange={setPrefixesDraft}
          onBlur={() => void setPrefixes(parseLines(prefixesDraft))}
        />
      </SettingRow>
    </SettingGroup>
  )
}

export default AgentToolApprovalSettings
