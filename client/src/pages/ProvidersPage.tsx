import { useState, useEffect } from 'react';
import {
  makeStyles,
  tokens,
  Title2,
  Title3,
  Body1,
  Caption1,
  Badge,
  Card,
  CardHeader,
  Spinner,
  Divider,
  Switch,
  Text,
  Button,
  MessageBar,
  MessageBarBody,
  Field,
  Input,
  Select,
} from '@fluentui/react-components';
import {
  BrainCircuitRegular,
  CheckmarkCircleRegular,
  DismissCircleRegular,
  EditRegular,
  SaveRegular,
  DismissRegular,
} from '@fluentui/react-icons';
import { api, ApiError } from '../api/client.js';
import type { SafeLlmProviderConfig, ProviderModels, ProviderUpdate, ModelEntry } from '../api/types.js';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    maxWidth: '900px',
    width: '100%',
  },
  providerGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
    gap: tokens.spacingVerticalM,
    '@media (max-width: 600px)': {
      gridTemplateColumns: '1fr',
    },
  },
  providerCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metaGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
  },
  metaLabel: {
    color: tokens.colorNeutralForeground3,
  },
  editForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalS,
    borderTopWidth: tokens.strokeWidthThin,
    borderTopStyle: 'solid',
    borderTopColor: tokens.colorNeutralStroke2,
  },
  editRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: tokens.spacingHorizontalM,
  },
  editActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
  },
  testResult: {
    marginTop: tokens.spacingVerticalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: 'monospace',
    fontSize: tokens.fontSizeBase200,
  },
  hintText: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  emptyState: {
    textAlign: 'center',
    padding: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForeground3,
  },
  cardFooter: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
  },
});

const PROVIDER_DISPLAY: Record<string, string> = {
  gemini: 'Google Gemini',
  groq: 'Groq',
};

interface TestState {
  loading: boolean;
  success?: boolean;
  latencyMs?: number;
  error?: string;
  result?: { changed: boolean; summary: string };
}

interface ProviderEditDraft {
  model: string;
  apiKey: string;
  priority: string;
  timeoutSeconds: string;
  maxRetries: string;
}

export function ProvidersPage() {
  const styles = useStyles();
  const [providers, setProviders] = useState<SafeLlmProviderConfig[]>([]);
  const [models, setModels] = useState<ProviderModels[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ProviderEditDraft | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [p, m] = await Promise.all([api.providers.list(), api.providers.models()]);
        setProviders(p);
        setModels(m);
      } catch (err) {
        setErrorMsg(err instanceof ApiError ? err.message : 'Failed to load providers.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  function handleEditStart(provider: SafeLlmProviderConfig) {
    setEditingId(provider.id);
    setEditDraft({
      model: provider.model,
      apiKey: '',
      priority: String(provider.priority),
      timeoutSeconds: String(provider.timeoutMs / 1000),
      maxRetries: String(provider.maxRetries),
    });
    setEditError(null);
  }

  function handleEditCancel() {
    setEditingId(null);
    setEditDraft(null);
    setEditError(null);
  }

  async function handleEditSave(id: string) {
    if (!editDraft) return;
    setEditSaving(true);
    setEditError(null);
    try {
      const update: ProviderUpdate = {
        id: id as 'gemini' | 'groq',
        model: editDraft.model,
        priority: Math.max(1, parseInt(editDraft.priority, 10) || 1),
        timeoutMs: Math.max(1000, (parseInt(editDraft.timeoutSeconds, 10) || 30) * 1000),
        maxRetries: Math.max(0, parseInt(editDraft.maxRetries, 10) || 0),
      };
      if (editDraft.apiKey.trim()) {
        update.apiKey = editDraft.apiKey.trim();
      }
      const updated = await api.providers.update({ providers: [update] });
      setProviders(updated);
      setEditingId(null);
      setEditDraft(null);
    } catch (err) {
      setEditError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setEditSaving(false);
    }
  }

  async function handleToggle(id: string, enabled: boolean) {
    try {
      const updated = await api.providers.update({
        providers: [{ id: id as 'gemini' | 'groq', enabled }],
      });
      setProviders(updated);
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : 'Failed to update provider.');
    }
  }

  async function handleTest(id: string) {
    setTestStates((prev) => ({ ...prev, [id]: { loading: true } }));
    try {
      const result = await api.providers.test({ providerId: id as 'gemini' | 'groq' });
      setTestStates((prev) => ({
        ...prev,
        [id]: {
          loading: false,
          success: result.success,
          latencyMs: result.latencyMs,
          error: result.error,
          result: result.result,
        },
      }));
    } catch (err) {
      setTestStates((prev) => ({
        ...prev,
        [id]: {
          loading: false,
          success: false,
          error: err instanceof ApiError ? err.message : 'Test failed.',
        },
      }));
    }
  }

  if (loading) {
    return (
      <div className={styles.emptyState}>
        <Spinner label="Loading providers…" />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM }}>
        <Title2>LLM Providers</Title2>
        <Badge appearance="outline">{providers.filter((p) => p.enabled).length} active</Badge>
      </div>

      {errorMsg && (
        <MessageBar intent="error">
          <MessageBarBody>{errorMsg}</MessageBarBody>
        </MessageBar>
      )}

      <Divider />

      <div className={styles.providerGrid}>
        {providers.map((provider) => {
          const displayName = PROVIDER_DISPLAY[provider.id] ?? provider.id;
          const modelsForProvider = models.find((m) => m.providerId === provider.id);
          const test = testStates[provider.id];
          const isEditing = editingId === provider.id;

          return (
            <Card key={provider.id}>
              <CardHeader
                image={<BrainCircuitRegular fontSize={24} />}
                header={
                  <div className={styles.row}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                      <Title3>{displayName}</Title3>
                      {provider.enabled ? (
                        <Badge appearance="filled" color="success" icon={<CheckmarkCircleRegular />}>
                          Enabled
                        </Badge>
                      ) : (
                        <Badge appearance="outline" color="informative" icon={<DismissCircleRegular />}>
                          Disabled
                        </Badge>
                      )}
                    </div>
                    <Switch
                      checked={provider.enabled}
                      onChange={(_e, data) => void handleToggle(provider.id, data.checked)}
                      label=""
                    />
                  </div>
                }
              />

              <div className={styles.providerCard}>
                {/* Meta grid (read view) */}
                {!isEditing && (
                  <div className={styles.metaGrid}>
                    <Caption1 className={styles.metaLabel}>Model</Caption1>
                    <Caption1>{provider.model}</Caption1>

                    <Caption1 className={styles.metaLabel}>Priority</Caption1>
                    <Caption1>{provider.priority}</Caption1>

                    <Caption1 className={styles.metaLabel}>API Key</Caption1>
                    <Caption1>
                      {provider.apiKeyConfigured ? (
                        <Badge appearance="filled" color="success" size="small">Configured</Badge>
                      ) : (
                        <Badge appearance="outline" color="warning" size="small">Not set</Badge>
                      )}
                    </Caption1>

                    <Caption1 className={styles.metaLabel}>Timeout</Caption1>
                    <Caption1>{provider.timeoutMs / 1000} s</Caption1>

                    <Caption1 className={styles.metaLabel}>Retries</Caption1>
                    <Caption1>{provider.maxRetries}</Caption1>
                  </div>
                )}


                {/* Inline edit form */}
                {isEditing && editDraft && (
                  <div className={styles.editForm}>
                    <Field label="Model">
                      <Select
                        value={editDraft.model}
                        onChange={(e) =>
                          setEditDraft((d) => d ? { ...d, model: e.target.value } : d)
                        }
                      >
                        {(modelsForProvider?.models ?? [{ id: editDraft.model, tier: 'paid' as const }]).map((m: ModelEntry) => (
                          <option key={m.id} value={m.id}>
                            {m.id} ({m.tier})
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field label="API Key">
                      <Input
                        type="password"
                        value={editDraft.apiKey}
                        onChange={(e) =>
                          setEditDraft((d) => d ? { ...d, apiKey: e.target.value } : d)
                        }
                        placeholder={
                          provider.apiKeyConfigured
                            ? 'Leave blank to keep current key'
                            : 'Enter API key'
                        }
                      />
                    </Field>
                    <Text className={styles.hintText}>API key is write-only and never echoed back.</Text>

                    <div className={styles.editRow}>
                      <Field label="Priority">
                        <Input
                          type="number"
                          value={editDraft.priority}
                          onChange={(e) =>
                            setEditDraft((d) => d ? { ...d, priority: e.target.value } : d)
                          }
                          min={1}
                        />
                      </Field>
                      <Field label="Timeout (seconds)">
                        <Input
                          type="number"
                          value={editDraft.timeoutSeconds}
                          onChange={(e) =>
                            setEditDraft((d) => d ? { ...d, timeoutSeconds: e.target.value } : d)
                          }
                          min={1}
                        />
                      </Field>
                    </div>

                    <Field label="Max retries">
                      <Input
                        type="number"
                        value={editDraft.maxRetries}
                        onChange={(e) =>
                          setEditDraft((d) => d ? { ...d, maxRetries: e.target.value } : d)
                        }
                        min={0}
                        max={10}
                      />
                    </Field>

                    {editError && (
                      <Text style={{ color: tokens.colorStatusDangerForeground1, fontSize: tokens.fontSizeBase200 }}>
                        {editError}
                      </Text>
                    )}

                    <div className={styles.editActions}>
                      <Button
                        icon={<DismissRegular />}
                        appearance="subtle"
                        size="small"
                        onClick={handleEditCancel}
                        disabled={editSaving}
                      >
                        Cancel
                      </Button>
                      <Button
                        icon={editSaving ? <Spinner size="tiny" /> : <SaveRegular />}
                        appearance="primary"
                        size="small"
                        onClick={() => void handleEditSave(provider.id)}
                        disabled={editSaving}
                      >
                        {editSaving ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </div>
                )}

                <Divider />

                <div className={styles.cardFooter}>
                  {!isEditing ? (
                    <Button
                      icon={<EditRegular />}
                      size="small"
                      appearance="outline"
                      onClick={() => handleEditStart(provider)}
                    >
                      Edit
                    </Button>
                  ) : (
                    <div />
                  )}

                  {!isEditing && (
                    <Button
                      size="small"
                      appearance="outline"
                      disabled={!provider.apiKeyConfigured || !provider.enabled || test?.loading}
                      icon={test?.loading ? <Spinner size="tiny" /> : undefined}
                      onClick={() => void handleTest(provider.id)}
                    >
                      Test connection
                    </Button>
                  )}
                </div>

                {test && !test.loading && !isEditing && (
                  <div className={styles.testResult}>
                    {test.success ? (
                      <>
                        <Body1 style={{ color: tokens.colorStatusSuccessForeground1 }}>
                          ✓ Connected — {test.latencyMs}ms
                        </Body1>
                        {test.result && (
                          <div style={{ marginTop: tokens.spacingVerticalXS }}>
                            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                              Model response:
                            </Caption1>
                            <div style={{ fontFamily: 'monospace', fontSize: tokens.fontSizeBase200, marginTop: '2px' }}>
                              <span style={{ color: test.result.changed ? tokens.colorStatusWarningForeground1 : tokens.colorStatusSuccessForeground1 }}>
                                changed: {String(test.result.changed)}
                              </span>
                              <br />
                              <span>summary: "{test.result.summary}"</span>
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <Body1 style={{ color: tokens.colorStatusDangerForeground1 }}>
                        ✗ {test.error ?? 'Connection failed'}
                      </Body1>
                    )}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
