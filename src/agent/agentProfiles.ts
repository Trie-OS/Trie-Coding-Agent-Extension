export type AgentProfileName = 'default' | 'accept-edits' | 'auto-approve' | 'explore'

export type PermissionDefault = 'allow' | 'ask' | 'deny'

export interface ProfilePermissions {
  shell: PermissionDefault
  sensitiveWrite: PermissionDefault
  outsideWorkspace: PermissionDefault
}

const PROFILE_PERMISSIONS: Record<AgentProfileName, ProfilePermissions> = {
  default: {
    shell: 'ask',
    sensitiveWrite: 'ask',
    outsideWorkspace: 'ask',
  },
  'accept-edits': {
    shell: 'ask',
    sensitiveWrite: 'allow',
    outsideWorkspace: 'ask',
  },
  'auto-approve': {
    shell: 'allow',
    sensitiveWrite: 'allow',
    outsideWorkspace: 'allow',
  },
  explore: {
    shell: 'deny',
    sensitiveWrite: 'deny',
    outsideWorkspace: 'ask',
  },
}

export function normalizeAgentProfile(value: string | undefined): AgentProfileName {
  if (value === 'accept-edits' || value === 'auto-approve' || value === 'explore') return value
  return 'default'
}

export function profilePermissions(profile: AgentProfileName): ProfilePermissions {
  return PROFILE_PERMISSIONS[profile] ?? PROFILE_PERMISSIONS.default
}
