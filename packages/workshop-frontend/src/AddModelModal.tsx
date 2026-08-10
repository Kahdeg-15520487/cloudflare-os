import { useState, useEffect, useRef } from 'react'
import { Dialog, Button, Input, Select, SensitiveInput, Collapsible, useKumoToastManager } from '@cloudflare/kumo'
import { AiChatAuthorInfo, AiModelConfig, AiModelProvider, AiGatewayInfo, SUGGESTED_MODELS, CopilotDeviceCode, CopilotLoginAttempt } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'

interface AddModelModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  aiConfig: AiGatewayInfo | null
}

type SelectionType =
  | { type: 'suggested', provider: AiModelProvider, modelId: string, displayName: string }
  | { type: 'custom', provider: AiModelProvider }

const PROVIDER_LABELS: Record<AiModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  cloudflare: 'Cloudflare Workers AI',
  ollama: 'Ollama',
  'github-copilot': 'GitHub Copilot',
}

// Placeholder hinting at the shape of each provider's API token.
const API_TOKEN_PLACEHOLDERS: Record<AiModelProvider, string> = {
  anthropic: 'sk-ant-...',
  openai: 'sk-...',
  google: 'AIza...',
  cloudflare: 'Cloudflare API token',
  ollama: '(optional)',
  'github-copilot': 'Sign in with GitHub Copilot to generate',
}

// Example used in the custom-model placeholders for providers that have no suggested models
// (currently Ollama, which serves whatever the user has pulled locally).
const FALLBACK_EXAMPLE_MODEL = { modelId: 'gemma4:31b', name: 'Gemma 4 31B' }

// Pick an example model to show in the custom-model placeholders for the given provider.
function exampleModel(provider: AiModelProvider): { modelId: string, name: string } {
  const first = Object.entries(SUGGESTED_MODELS[provider])[0]
  return first ? { modelId: first[0], name: first[1].name } : FALLBACK_EXAMPLE_MODEL
}

// Encode a selection into a string value for the Select component.
function encodeSelection(provider: AiModelProvider, modelId?: string): string {
  return modelId ? `${provider}:${modelId}` : `other-${provider}`
}

// Decode a Select value back into a SelectionType.
function decodeSelection(value: string): SelectionType {
  if (value.startsWith('other-')) {
    return { type: 'custom', provider: value.substring(6) as AiModelProvider }
  }
  const colonIndex = value.indexOf(':')
  const provider = value.substring(0, colonIndex) as AiModelProvider
  const modelId = value.substring(colonIndex + 1)
  const displayName = SUGGESTED_MODELS[provider][modelId].name
  return { type: 'suggested', provider, modelId, displayName }
}

// Build the flat list of options for the Select dropdown. `copilotAvailable`, when set (a
// successful Copilot sign-in reported the account's model ids), hides Copilot suggestions the
// account cannot use.
function buildOptions(gatewayMode: boolean, enabledProviders: Set<string> | null,
    copilotAvailable: Set<string> | null) {
  const options: { value: string; label: string; provider: string }[] = []
  const providerOrder = Object.keys(SUGGESTED_MODELS) as AiModelProvider[]

  for (const provider of providerOrder) {
    if (enabledProviders && !enabledProviders.has(provider)) continue

    // In gateway mode, suggested models are already built-in, so don't list them.
    if (!gatewayMode) {
      for (const [modelId, model] of Object.entries(SUGGESTED_MODELS[provider])) {
        if (provider === 'github-copilot' && copilotAvailable && !copilotAvailable.has(modelId)) continue
        options.push({
          value: encodeSelection(provider, modelId),
          label: model.name,
          provider,
        })
      }
    }

    options.push({
      value: encodeSelection(provider),
      label: `Other ${PROVIDER_LABELS[provider] || provider}...`,
      provider,
    })
  }

  return options
}

export default function AddModelModal({ visible, onCancel, onSuccess, authenticatedApi, aiConfig }: AddModelModalProps) {
  const toasts = useKumoToastManager()

  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<SelectionType | null>(null)
  const [selectValue, setSelectValue] = useState<string | undefined>(undefined)

  // Form fields (used for custom models)
  const [modelId, setModelId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [accountId, setAccountId] = useState('')
  const [apiUrl, setApiUrl] = useState('')

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Advanced settings collapsible state
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // GitHub Copilot device-flow sign-in state.
  type CopilotPhase = 'idle' | 'starting' | 'awaiting-code' | 'signed-in' | 'error'
  const [copilotPhase, setCopilotPhase] = useState<CopilotPhase>('idle')
  const [copilotCode, setCopilotCode] = useState<CopilotDeviceCode | null>(null)
  const [copilotError, setCopilotError] = useState('')
  // Copilot model ids the signed-in account may use, when GitHub reported them.
  const [copilotAvailable, setCopilotAvailable] = useState<Set<string> | null>(null)
  const copilotStub = useRef<RpcStub<CopilotLoginAttempt> | null>(null)
  const copilotCancelled = useRef(false)

  const cancelCopilotLogin = () => {
    const stub = copilotStub.current
    copilotStub.current = null
    if (stub) {
      stub.cancel()
      stub[Symbol.dispose]()
    }
  }

  const handleCopilotSignIn = async () => {
    setCopilotPhase('starting')
    setCopilotError('')
    copilotCancelled.current = false
    try {
      const stub = await authenticatedApi.startCopilotLogin()
      copilotStub.current = stub
      const code = await stub.waitForDeviceCode()
      setCopilotCode(code)
      setCopilotPhase('awaiting-code')
      const result = await stub.wait()
      copilotStub.current = null
      stub[Symbol.dispose]()
      setCopilotAvailable(result.availableModelIds ? new Set(result.availableModelIds) : null)
      // Auto-select the first Copilot suggestion the account can use.
      const suggestions = Object.entries(SUGGESTED_MODELS['github-copilot'])
      const pick = result.availableModelIds
        ? suggestions.find(([id]) => result.availableModelIds!.includes(id)) ?? suggestions[0]
        : suggestions[0]
      if (pick) {
        const sel = {
          type: 'suggested' as const,
          provider: 'github-copilot' as const,
          modelId: pick[0],
          displayName: pick[1].name,
        }
        setSelection(sel)
        setSelectValue(encodeSelection(sel.provider, sel.modelId))
        setModelId(sel.modelId)
        setDisplayName(sel.displayName)
      }
      setCopilotPhase('signed-in')
    } catch (error: any) {
      copilotStub.current = null
      if (copilotCancelled.current) {
        copilotCancelled.current = false
        setCopilotPhase('idle')
      } else {
        setCopilotError(error?.message ?? String(error))
        setCopilotPhase('error')
      }
    }
  }

  const handleCopilotSignOut = async () => {
    try {
      await authenticatedApi.disconnectCopilotLogin()
      setCopilotPhase('idle')
      setCopilotCode(null)
      setCopilotAvailable(null)
      setCopilotError('')
    } catch (error: any) {
      setCopilotError(error?.message ?? String(error))
      setCopilotPhase('error')
    }
  }

  const handleCopilotCancel = () => {
    copilotCancelled.current = true
    cancelCopilotLogin()
    setCopilotCode(null)
    setCopilotPhase('idle')
  }

  const gatewayMode = aiConfig?.enabled === true
  const enabledProviders: Set<string> | null = gatewayMode
    ? new Set(aiConfig.enabledProviders)
    : null

  // Reset all state when dialog closes; on open, pick up an existing stored Copilot sign-in
  // so adding another Copilot model never re-runs the OAuth flow.
  useEffect(() => {
    if (!visible) {
      copilotCancelled.current = true
      cancelCopilotLogin()
      setCopilotPhase('idle')
      setCopilotCode(null)
      setCopilotError('')
      setCopilotAvailable(null)
      setSelection(null)
      setSelectValue(undefined)
      setModelId('')
      setDisplayName('')
      setApiToken('')
      setAccountId('')
      setApiUrl('')
      setErrors({})
      setAdvancedOpen(false)
    }
  }, [visible])

  useEffect(() => {
    if (!visible || gatewayMode) return
    let disposed = false
    authenticatedApi.getCopilotLoginStatus().then((status) => {
      if (disposed) return
      if (status.signedIn) {
        setCopilotPhase('signed-in')
        setCopilotAvailable(status.availableModelIds ? new Set(status.availableModelIds) : null)
      }
    }).catch(() => {
      // Status check failed (e.g. backend hiccup); fall back to the sign-in button.
    })
    return () => { disposed = true }
  }, [visible, gatewayMode, authenticatedApi])

  const handleModelSelect = (value: string) => {
    setSelectValue(value)
    setErrors({})
    const sel = decodeSelection(value)
    setSelection(sel)

    if (sel.type === 'custom') {
      setModelId('')
      setDisplayName('')
    } else {
      setModelId(sel.modelId)
      setDisplayName(sel.displayName)
    }
    setApiToken('')
    setAccountId('')
    setApiUrl(sel.provider === 'ollama' ? 'http://localhost:11434' : '')
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}

    if (!selection) {
      newErrors.selection = gatewayMode ? 'Please select a provider' : 'Please select a model'
    }

    if (selection?.type === 'custom') {
      if (!modelId.trim()) newErrors.modelId = 'Please enter the model ID'
      if (!displayName.trim()) newErrors.displayName = 'Please enter a display name'
    }

    const isOllama = selection?.provider === 'ollama'
    const isCloudflare = selection?.provider === 'cloudflare'
    const showCredentials = !gatewayMode

    if (showCredentials && selection && !isOllama) {
      if (selection.provider === 'github-copilot') {
        if (copilotPhase !== 'signed-in') {
          newErrors.apiToken = 'Sign in with GitHub Copilot to generate a token'
        }
      } else if (!apiToken.trim()) {
        newErrors.apiToken = 'Please enter your API token'
      }
    }

    if (showCredentials && isCloudflare && !accountId.trim()) {
      newErrors.accountId = 'Please enter your Cloudflare account ID'
    }

    if (showCredentials && isOllama && !apiUrl.trim()) {
      newErrors.apiUrl = 'Please enter the Ollama API URL'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async () => {
    if (!validate()) return

    setLoading(true)
    try {
      const isSuggested = selection!.type === 'suggested'
      const finalModelId = isSuggested ? selection!.modelId : modelId.trim()
      const finalDisplayName = isSuggested ? selection!.displayName : displayName.trim()

      const profile: AiChatAuthorInfo = {
        type: 'agent',
        id: finalModelId,
        name: finalDisplayName,
      }

      const config: AiModelConfig = {
        provider: selection!.provider,
        model: finalModelId,
        // GitHub Copilot models carry no user-entered key: the backend fills apiToken from
        // the account's stored sign-in (shared by every Copilot model).
        apiToken: gatewayMode ? '' :
            (selection!.provider === 'github-copilot' ? '' : apiToken.trim()),
        ...(!gatewayMode && accountId.trim() && { accountId: accountId.trim() }),
        ...(!gatewayMode && apiUrl.trim() && { apiUrl: apiUrl.trim() }),
      }

      await authenticatedApi.addModel(profile, config)
      toasts.add({ title: 'AI model added successfully', variant: 'success' })
      onSuccess()
    } catch (error: any) {
      console.error('Failed to add model:', error)
      toasts.add({ title: 'Failed to add model', variant: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const options = buildOptions(gatewayMode, enabledProviders, copilotAvailable)
  const showCustomFields = selection?.type === 'custom'
  const example = selection ? exampleModel(selection.provider) : null
  const isOllama = selection?.provider === 'ollama'
  const isCloudflare = selection?.provider === 'cloudflare'
  const showCredentials = !gatewayMode

  // Group options by provider for rendering with visual separators.
  const groupedOptions: { provider: string; items: typeof options }[] = []
  for (const opt of options) {
    const last = groupedOptions[groupedOptions.length - 1]
    if (last && last.provider === opt.provider) {
      last.items.push(opt)
    } else {
      groupedOptions.push({ provider: opt.provider, items: [opt] })
    }
  }

  return (
    <Dialog.Root open={visible} onOpenChange={(open) => { if (!open) onCancel() }}>
      <Dialog className="p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold mb-4">
          Add AI Model
        </Dialog.Title>

        <div className="space-y-4">
          {/* Model / Provider selection */}
          <Select
            label={gatewayMode ? 'Select Provider' : 'Select Model'}
            className="w-full text-sm"
            placeholder={gatewayMode ? 'Choose a provider...' : 'Choose an AI model...'}
            value={selectValue}
            onValueChange={(v) => handleModelSelect(v as string)}
            error={errors.selection}
            renderValue={(v) => {
              const opt = options.find(o => o.value === v)
              return opt?.label ?? String(v)
            }}
          >
            {groupedOptions.map((group, groupIndex) => (
              <div key={group.provider}>
                {groupIndex > 0 && (
                  <div className="h-px bg-kumo-line my-1 mx-2" />
                )}
                <div className="px-3 py-1.5 text-xs font-medium text-kumo-subtle select-none">
                  {PROVIDER_LABELS[group.provider as AiModelProvider] || group.provider}
                </div>
                {group.items.map(opt => (
                  <Select.Option key={opt.value} value={opt.value}>
                    {opt.label}
                  </Select.Option>
                ))}
              </div>
            ))}
          </Select>

          {/* GitHub Copilot device-flow sign-in (no API key required) */}
          {showCredentials && (
            <div className="rounded-lg border border-kumo-line p-3 space-y-2">
              {copilotPhase === 'idle' && (
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm">
                    <div className="font-medium">GitHub Copilot</div>
                    <div className="text-xs text-kumo-subtle">Use your GitHub Copilot subscription — no API key needed.</div>
                  </div>
                  <Button variant="secondary" onClick={handleCopilotSignIn}>Sign in with GitHub Copilot</Button>
                </div>
              )}
              {copilotPhase === 'starting' && (
                <div className="text-sm text-kumo-subtle">Starting sign-in…</div>
              )}
              {copilotPhase === 'awaiting-code' && copilotCode && (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Authorize GitHub Copilot</div>
                  <div className="text-sm">
                    Open{' '}
                    <a href={copilotCode.verificationUri} target="_blank" rel="noreferrer"
                        className="underline text-kumo-link">
                      {copilotCode.verificationUri}
                    </a>{' '}
                    and enter:
                  </div>
                  <div className="rounded bg-kumo-surface px-4 py-2 text-center font-mono text-xl tracking-widest">
                    {copilotCode.userCode}
                  </div>
                  <div className="text-xs text-kumo-subtle">
                    Waiting for you to authorize…{' '}
                    {copilotCode.expiresInSeconds ? `(code expires in ~${Math.ceil(copilotCode.expiresInSeconds / 60)} min)` : ''}
                  </div>
                  <Button variant="secondary" onClick={handleCopilotCancel}>Cancel</Button>
                </div>
              )}
              {copilotPhase === 'signed-in' && (
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm text-green-700 dark:text-green-400">
                    ✓ Signed in with GitHub Copilot. Pick any Copilot model above and press Add Model.
                  </div>
                  <Button variant="secondary" onClick={handleCopilotSignOut}>Sign out</Button>
                </div>
              )}
              {copilotPhase === 'error' && (
                <div className="space-y-2">
                  <div className="text-sm text-red-700 dark:text-red-400">Sign-in failed: {copilotError}</div>
                  <Button variant="secondary" onClick={handleCopilotSignIn}>Retry</Button>
                </div>
              )}
            </div>
          )}

          {/* Custom model fields */}
          {showCustomFields && (
            <>
              <Input
                label="Model ID"
                placeholder={`e.g., ${example!.modelId}`}
                description={`The model identifier as specified by the provider (e.g., '${example!.modelId}')`}
                value={modelId}
                onChange={(e) => { setModelId(e.target.value); setErrors(prev => ({ ...prev, modelId: '' })) }}
                error={errors.modelId}
                variant={errors.modelId ? 'error' : 'default'}
              />

              <Input
                label="Display Name"
                placeholder={`e.g., ${example!.name}`}
                description="Human-readable name shown in the UI"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); setErrors(prev => ({ ...prev, displayName: '' })) }}
                error={errors.displayName}
                variant={errors.displayName ? 'error' : 'default'}
              />
            </>
          )}

          {/* Cloudflare account ID (the Workers AI REST endpoint is account-scoped) */}
          {showCredentials && isCloudflare && (
            <Input
              label="Cloudflare Account ID"
              placeholder="e.g., 0123456789abcdef0123456789abcdef"
              description="The Cloudflare account to bill for Workers AI usage"
              value={accountId}
              onChange={(e) => { setAccountId(e.target.value); setErrors(prev => ({ ...prev, accountId: '' })) }}
              error={errors.accountId}
              variant={errors.accountId ? 'error' : 'default'}
            />
          )}

          {/* API Token — hidden for GitHub Copilot: its credential comes from the sign-in panel */}
          {showCredentials && selection && selection.provider !== 'github-copilot' && (
            <SensitiveInput
              label="API Token"
              placeholder={API_TOKEN_PLACEHOLDERS[selection.provider]}
              description={
                isOllama
                  ? 'Optional for local Ollama access'
                  : isCloudflare
                  ? 'An API token with Workers AI Read + Edit permissions (in the dashboard: Workers AI > Use REST API > Create a Workers AI API Token)'
                  : `Your ${PROVIDER_LABELS[selection.provider]} API token for billing`
              }
              value={apiToken}
              onValueChange={(v) => { setApiToken(v); setErrors(prev => ({ ...prev, apiToken: '' })) }}
              error={errors.apiToken}
              variant={errors.apiToken ? 'error' : 'default'}
            />
          )}

          {/* Ollama API URL (always visible for Ollama) */}
          {showCredentials && isOllama && (
            <Input
              label="API URL"
              placeholder="http://localhost:11434"
              description="URL of your Ollama server"
              value={apiUrl}
              onChange={(e) => { setApiUrl(e.target.value); setErrors(prev => ({ ...prev, apiUrl: '' })) }}
              error={errors.apiUrl}
              variant={errors.apiUrl ? 'error' : 'default'}
            />
          )}

          {/* Advanced Settings for non-Ollama, non-Cloudflare providers */}
          {showCredentials && selection && !isOllama && !isCloudflare && (
            <Collapsible.Root
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
            >
              <Collapsible.DefaultTrigger>Advanced Settings</Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel>
                <Input
                  label="API URL"
                  placeholder="https://..."
                  description="Override the default API endpoint (useful for proxies like Cloudflare AI Gateway)"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                />
              </Collapsible.DefaultPanel>
            </Collapsible.Root>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close render={(props) => (
            <Button variant="secondary" {...props} disabled={loading}>
              Cancel
            </Button>
          )} />
          <Button
            variant="primary"
            onClick={handleSubmit}
            loading={loading}
            disabled={!selection}
          >
            Add Model
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
