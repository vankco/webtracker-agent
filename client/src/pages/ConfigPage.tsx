import { useState, useEffect, useCallback } from 'react';
import {
  makeStyles,
  tokens,
  Title2,
  Title3,
  Caption1,
  Badge,
  Card,
  CardHeader,
  Spinner,
  Divider,
  Button,
  MessageBar,
  MessageBarBody,
  Field,
  Input,
  Textarea,
  Switch,
  Text,
} from '@fluentui/react-components';
import {
  SaveRegular,
  ArrowCounterclockwiseRegular,
  GlobeRegular,
  TimerRegular,
  AlertRegular,
  SettingsRegular,
  EditRegular,
  DismissRegular,
  LinkMultipleRegular,
  AddRegular,
  DeleteRegular,
} from '@fluentui/react-icons';
import { api, ApiError } from '../api/client.js';
import type { SafeAppConfig, PutConfigRequest, SiteConfig, SiteSchedule } from '../api/types.js';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    maxWidth: '900px',
    width: '100%',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
  },
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))',
    gap: tokens.spacingVerticalM,
    '@media (max-width: 600px)': {
      gridTemplateColumns: '1fr',
    },
  },
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  hintText: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  webhookRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'flex-end',
  },
  siteRow: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingVerticalM,
  },
  siteRowHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
  },
  windowRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr auto',
    gap: tokens.spacingHorizontalXS,
    alignItems: 'center',
  },
  emptyState: {
    textAlign: 'center',
    padding: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForeground3,
  },
  stickyBar: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    justifyContent: 'flex-end',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    backgroundColor: tokens.colorNeutralBackground1,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    zIndex: 100,
    '@media (min-width: 601px)': {
      display: 'none',
    },
  },
  pageBottomPad: {
    '@media (max-width: 600px)': {
      paddingBottom: '72px',
    },
  },
});

interface Draft {
  intervalSeconds: string;
  runOnce: boolean;
  webhookNew: string;
  showWebhookEdit: boolean;
  systemWebhookNew: string;
  showSystemWebhookEdit: boolean;
  productWatchUrls: string;
}

/** Normalize a newline-separated URL list to a trimmed, non-empty array. */
function parseWatchUrls(text: string): string[] {
  return text
    .split('\n')
    .map((u) => u.trim())
    .filter(Boolean);
}

function toDraft(config: SafeAppConfig): Draft {
  return {
    intervalSeconds: String(Math.round(config.schedule.intervalMs / 1000)),
    runOnce: config.schedule.runOnce,
    webhookNew: '',
    showWebhookEdit: false,
    systemWebhookNew: '',
    showSystemWebhookEdit: false,
    productWatchUrls: (config.productWatchUrls ?? []).join('\n'),
  };
}

function isDirty(draft: Draft, saved: SafeAppConfig): boolean {
  const intervalMs = (parseInt(draft.intervalSeconds, 10) || 0) * 1000;
  const watchChanged =
    parseWatchUrls(draft.productWatchUrls).join('\n') !== (saved.productWatchUrls ?? []).join('\n');
  return (
    intervalMs !== saved.schedule.intervalMs ||
    draft.runOnce !== saved.schedule.runOnce ||
    draft.webhookNew.trim() !== '' ||
    draft.systemWebhookNew.trim() !== '' ||
    watchChanged
  );
}

// ---------------------------------------------------------------------------
// Tracked Sites — per-site CRUD + schedule editor (independent of the draft Save)
// ---------------------------------------------------------------------------

function secToMs(s: string): number {
  return Math.max(1, Math.round((parseFloat(s) || 0) * 1000));
}
function msToSec(ms?: number): string {
  return ms != null ? String(Math.round(ms / 1000)) : '';
}

interface WindowDraft { startHour: string; endHour: string; intervalSec: string }

interface SiteDraft {
  url: string;
  selector: string;
  label: string;
  intervalSec: string;
  scheduleOn: boolean;
  timezone: string;
  schedDefaultSec: string;
  windows: WindowDraft[];
}

function siteToDraft(s: SiteConfig): SiteDraft {
  return {
    url: s.url,
    selector: s.selector,
    label: s.label ?? '',
    intervalSec: msToSec(s.intervalMs),
    scheduleOn: Boolean(s.schedule),
    timezone: s.schedule?.timezone ?? 'America/Los_Angeles',
    schedDefaultSec: msToSec(s.schedule?.intervalMs),
    windows: (s.schedule?.windows ?? []).map((w) => ({
      startHour: String(w.startHour),
      endHour: String(w.endHour),
      intervalSec: msToSec(w.intervalMs),
    })),
  };
}

/** Always returns a schedule object so toggling the schedule off clears windows. */
function draftToSchedule(d: SiteDraft): SiteSchedule {
  if (!d.scheduleOn) return {};
  const sched: SiteSchedule = {};
  if (d.timezone.trim()) sched.timezone = d.timezone.trim();
  if (d.schedDefaultSec.trim()) sched.intervalMs = secToMs(d.schedDefaultSec);
  const windows = d.windows
    .filter((w) => w.intervalSec.trim() !== '')
    .map((w) => ({
      startHour: Math.min(23, Math.max(0, parseInt(w.startHour, 10) || 0)),
      endHour: Math.min(24, Math.max(0, parseInt(w.endHour, 10) || 0)),
      intervalMs: secToMs(w.intervalSec),
    }));
  if (windows.length) sched.windows = windows;
  return sched;
}

function TrackedSites({
  sites,
  onChanged,
  onError,
}: {
  sites: SiteConfig[];
  onChanged: () => void | Promise<void>;
  onError: (m: string) => void;
}) {
  const styles = useStyles();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SiteDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const patchDraft = (p: Partial<SiteDraft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    onError('');
    try {
      await fn();
      await onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Site operation failed.');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = (id: string) =>
    void wrap(async () => {
      if (!draft) return;
      await api.sites.update(id, {
        url: draft.url.trim(),
        selector: draft.selector.trim(),
        label: draft.label.trim(),
        ...(draft.intervalSec.trim() ? { intervalMs: secToMs(draft.intervalSec) } : {}),
        schedule: draftToSchedule(draft),
      });
      setEditingId(null);
      setDraft(null);
    });

  return (
    <Card>
      <CardHeader
        image={<GlobeRegular fontSize={20} />}
        header={
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
            <Title3>Tracked Sites</Title3>
            <Badge appearance="outline" color="informative">{sites.length}</Badge>
          </div>
        }
      />
      <div className={styles.fieldGroup}>
        {sites.map((s) => {
          const editing = editingId === s.id;
          return (
            <div key={s.id} className={styles.siteRow}>
              <div className={styles.siteRowHead}>
                <div style={{ overflow: 'hidden' }}>
                  <Text weight="semibold">{s.label || s.url}</Text>
                  <div className={styles.hintText} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.url}>{s.url}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexShrink: 0 }}>
                  <Switch
                    checked={s.enabled}
                    disabled={busy}
                    onChange={() => void wrap(async () => { await api.sites.update(s.id, { enabled: !s.enabled }); })}
                    label={s.enabled ? 'On' : 'Off'}
                  />
                  <Button size="small" appearance="subtle" icon={<EditRegular />} disabled={busy}
                    onClick={() => (editing ? (setEditingId(null), setDraft(null)) : startEditRow(s))}>
                    {editing ? 'Close' : 'Edit'}
                  </Button>
                  <Button size="small" appearance="subtle" icon={<DeleteRegular />} disabled={busy || sites.length <= 1}
                    title={sites.length <= 1 ? 'Cannot remove the last site' : 'Remove site'}
                    onClick={() => void wrap(async () => { await api.sites.remove(s.id); })} />
                </div>
              </div>

              {editing && draft && (
                <div className={styles.fieldGroup} style={{ marginTop: tokens.spacingVerticalS }}>
                  <Field label="URL" required>
                    <Input value={draft.url} onChange={(e) => patchDraft({ url: e.target.value })} style={{ fontFamily: 'monospace' }} />
                  </Field>
                  <Field label="CSS Selector">
                    <Input value={draft.selector} onChange={(e) => patchDraft({ selector: e.target.value })} placeholder="(entire page)" style={{ fontFamily: 'monospace' }} />
                  </Field>
                  <Field label="Label">
                    <Input value={draft.label} onChange={(e) => patchDraft({ label: e.target.value })} placeholder="(optional)" />
                  </Field>
                  <Field label="Per-site interval (seconds, blank = use global)">
                    <Input type="number" min={1} value={draft.intervalSec} onChange={(e) => patchDraft({ intervalSec: e.target.value })} />
                  </Field>

                  <Field label="Time-of-day schedule">
                    <Switch checked={draft.scheduleOn} onChange={(_e, d) => patchDraft({ scheduleOn: d.checked })}
                      label={draft.scheduleOn ? 'On' : 'Off (use interval / plugin default)'} />
                  </Field>
                  {draft.scheduleOn && (
                    <div className={styles.fieldGroup} style={{ paddingLeft: tokens.spacingHorizontalM }}>
                      <Field label="Timezone (IANA)">
                        <Input value={draft.timezone} onChange={(e) => patchDraft({ timezone: e.target.value })} placeholder="America/Los_Angeles" style={{ fontFamily: 'monospace' }} />
                      </Field>
                      <Field label="Default cadence outside windows (seconds)">
                        <Input type="number" min={1} value={draft.schedDefaultSec} onChange={(e) => patchDraft({ schedDefaultSec: e.target.value })} />
                      </Field>
                      <Caption1 className={styles.hintText}>Windows (start hour → end hour, cadence). End may wrap past midnight.</Caption1>
                      {draft.windows.map((w, i) => (
                        <div key={i} className={styles.windowRow}>
                          <Input type="number" min={0} max={23} value={w.startHour} placeholder="start"
                            onChange={(e) => patchDraft({ windows: draft.windows.map((x, j) => j === i ? { ...x, startHour: e.target.value } : x) })} />
                          <Input type="number" min={0} max={24} value={w.endHour} placeholder="end"
                            onChange={(e) => patchDraft({ windows: draft.windows.map((x, j) => j === i ? { ...x, endHour: e.target.value } : x) })} />
                          <Input type="number" min={1} value={w.intervalSec} placeholder="sec"
                            onChange={(e) => patchDraft({ windows: draft.windows.map((x, j) => j === i ? { ...x, intervalSec: e.target.value } : x) })} />
                          <Button size="small" appearance="subtle" icon={<DismissRegular />}
                            onClick={() => patchDraft({ windows: draft.windows.filter((_x, j) => j !== i) })} />
                        </div>
                      ))}
                      <Button size="small" appearance="outline" icon={<AddRegular />}
                        onClick={() => patchDraft({ windows: [...draft.windows, { startHour: '6', endHour: '11', intervalSec: '120' }] })}>
                        Add window
                      </Button>
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
                    <Button size="small" appearance="primary" icon={<SaveRegular />} disabled={busy} onClick={() => saveEdit(s.id)}>Save site</Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {adding ? (
          <div className={styles.siteRow}>
            <div className={styles.fieldGroup}>
              <Field label="URL" required>
                <Input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="https://example.com" style={{ fontFamily: 'monospace' }} autoFocus />
              </Field>
              <Field label="Label">
                <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="(optional)" />
              </Field>
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
                <Button size="small" appearance="primary" icon={<AddRegular />} disabled={busy || !newUrl.trim()}
                  onClick={() => void wrap(async () => {
                    await api.sites.add({ url: newUrl.trim(), ...(newLabel.trim() ? { label: newLabel.trim() } : {}) });
                    setNewUrl(''); setNewLabel(''); setAdding(false);
                  })}>Add</Button>
                <Button size="small" appearance="subtle" onClick={() => { setAdding(false); setNewUrl(''); setNewLabel(''); }}>Cancel</Button>
              </div>
            </div>
          </div>
        ) : (
          <Button appearance="outline" icon={<AddRegular />} onClick={() => setAdding(true)} disabled={busy}>Add Site</Button>
        )}
      </div>
    </Card>
  );

  function startEditRow(s: SiteConfig) {
    setEditingId(s.id);
    setDraft(siteToDraft(s));
  }
}

export function ConfigPage() {
  const styles = useStyles();
  const [saved, setSaved] = useState<SafeAppConfig | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const config = await api.config.get();
      setSaved(config);
      setDraft(toDraft(config));
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : 'Failed to load config.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function setField<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setSuccessMsg(null);
    setErrorMsg(null);
  }

  async function handleSave() {
    if (!draft || !saved) return;
    const intervalMs = (parseInt(draft.intervalSeconds, 10) || 0) * 1000;
    if (intervalMs < 1000) {
      setErrorMsg('Interval must be at least 1 second (1000 ms).');
      return;
    }
    setSaving(true);
    setErrorMsg(null);
    try {
      const body: PutConfigRequest = {
        schedule: { intervalMs, runOnce: draft.runOnce },
        productWatchUrls: parseWatchUrls(draft.productWatchUrls),
      };
      if (draft.webhookNew.trim() || draft.systemWebhookNew.trim()) {
        body.notifications = {};
        if (draft.webhookNew.trim()) body.notifications.discordWebhookUrl = draft.webhookNew.trim();
        if (draft.systemWebhookNew.trim()) body.notifications.discordSystemWebhookUrl = draft.systemWebhookNew.trim();
      }
      const updated = await api.config.update(body);
      setSaved(updated);
      setDraft(toDraft(updated));
      setSuccessMsg('Configuration saved.');
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : 'Failed to save config.');
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    if (saved) {
      setDraft(toDraft(saved));
      setErrorMsg(null);
      setSuccessMsg(null);
    }
  }

  if (loading) {
    return (
      <div className={styles.emptyState}>
        <Spinner label="Loading configuration…" />
      </div>
    );
  }

  if (!saved || !draft) {
    return (
      <MessageBar intent="error">
        <MessageBarBody>{errorMsg ?? 'No configuration found.'}</MessageBarBody>
      </MessageBar>
    );
  }

  const dirty = isDirty(draft, saved);
  const webhookConfigured = Boolean(saved.notifications.discordWebhookUrl);
  const systemWebhookConfigured = Boolean(saved.notifications.discordSystemWebhookUrl);

  return (
    <div className={`${styles.root} ${styles.pageBottomPad}`}>
      {/* Header row */}
      <div className={styles.titleRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM }}>
          <Title2>Configuration</Title2>
          {dirty && (
            <Badge appearance="filled" color="warning" size="small">
              Unsaved changes
            </Badge>
          )}
        </div>
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
          {dirty && (
            <>
              <Button
                icon={<ArrowCounterclockwiseRegular />}
                appearance="subtle"
                onClick={handleReset}
                disabled={saving}
              >
                Reset
              </Button>
              <Button
                icon={<SaveRegular />}
                appearance="primary"
                onClick={() => void handleSave()}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          )}
        </div>
      </div>

      {errorMsg && (
        <MessageBar intent="error">
          <MessageBarBody>{errorMsg}</MessageBarBody>
        </MessageBar>
      )}
      {successMsg && (
        <MessageBar intent="success">
          <MessageBarBody>{successMsg}</MessageBarBody>
        </MessageBar>
      )}

      <Divider />

      {/* Tracked sites — managed via the sites CRUD API, independent of Save */}
      <TrackedSites sites={saved.sites} onChanged={load} onError={setErrorMsg} />

      <div className={styles.cardGrid}>
        {/* Product watch list */}
        <Card>
          <CardHeader
            image={<LinkMultipleRegular fontSize={20} />}
            header={<Title3>Product Watch List</Title3>}
          />
          <div className={styles.fieldGroup}>
            <Field label="Product detail URLs (one per line)">
              <Textarea
                value={draft.productWatchUrls}
                onChange={(e) => setField('productWatchUrls', e.target.value)}
                placeholder={'https://www.hermes.com/us/en/product/…\nhttps://www.hermes.com/us/en/product/…'}
                resize="vertical"
                rows={5}
                style={{ fontFamily: 'monospace' }}
              />
            </Field>
            <Text className={styles.hintText}>
              Each product page is re-checked every scrape and treated as the source of truth for
              availability, overriding the (less reliable) listing page. Leave blank to use the
              listing page only.
            </Text>
          </div>
        </Card>

        {/* Schedule */}
        <Card>
          <CardHeader image={<TimerRegular fontSize={20} />} header={<Title3>Schedule</Title3>} />
          <div className={styles.fieldGroup}>
            <Field label="Check interval (seconds)">
              <Input
                type="number"
                value={draft.intervalSeconds}
                onChange={(e) => setField('intervalSeconds', e.target.value)}
                min={1}
              />
            </Field>
            <Text className={styles.hintText}>
              Minimum 1 s. Common: 60 (1 m), 300 (5 m), 3600 (1 h).
            </Text>
            <Field label="Run-once mode">
              <Switch
                checked={draft.runOnce}
                onChange={(_e, data) => setField('runOnce', data.checked)}
                label={draft.runOnce ? 'On — exits after first check' : 'Off — runs continuously'}
              />
            </Field>
          </div>
        </Card>

        {/* Notifications */}
        <Card>
          <CardHeader image={<AlertRegular fontSize={20} />} header={<Title3>Notifications</Title3>} />
          <div className={styles.fieldGroup}>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Discord Webhook URL</Caption1>

            {!draft.showWebhookEdit ? (
              <div className={styles.webhookRow}>
                <Input
                  value={
                    webhookConfigured
                      ? '••••••••' + saved.notifications.discordWebhookUrl.slice(-8)
                      : '(not configured)'
                  }
                  readOnly
                  style={{ flex: 1, fontFamily: 'monospace' }}
                />
                <Button
                  icon={<EditRegular />}
                  appearance="outline"
                  size="small"
                  onClick={() => setField('showWebhookEdit', true)}
                >
                  {webhookConfigured ? 'Change' : 'Set'}
                </Button>
              </div>
            ) : (
              <div className={styles.fieldGroup}>
                <Input
                  type="url"
                  value={draft.webhookNew}
                  onChange={(e) => setField('webhookNew', e.target.value)}
                  placeholder="https://discord.com/api/webhooks/…"
                  style={{ fontFamily: 'monospace' }}
                  autoFocus
                />
                <Button
                  icon={<DismissRegular />}
                  appearance="subtle"
                  size="small"
                  onClick={() => {
                    setField('webhookNew', '');
                    setField('showWebhookEdit', false);
                  }}
                >
                  Cancel change
                </Button>
                <Text className={styles.hintText}>
                  Write-only — the value is never echoed back to the UI.
                </Text>
              </div>
            )}

            <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: tokens.spacingVerticalS }}>
              System / Debug Webhook URL
            </Caption1>
            <Text className={styles.hintText}>
              Health monitor and warn/error alerts. Falls back to the main webhook if not set.
            </Text>

            {!draft.showSystemWebhookEdit ? (
              <div className={styles.webhookRow}>
                <Input
                  value={
                    systemWebhookConfigured
                      ? '••••••••' + saved.notifications.discordSystemWebhookUrl.slice(-8)
                      : '(not configured — using main webhook)'
                  }
                  readOnly
                  style={{ flex: 1, fontFamily: 'monospace' }}
                />
                <Button
                  icon={<EditRegular />}
                  appearance="outline"
                  size="small"
                  onClick={() => setField('showSystemWebhookEdit', true)}
                >
                  {systemWebhookConfigured ? 'Change' : 'Set'}
                </Button>
              </div>
            ) : (
              <div className={styles.fieldGroup}>
                <Input
                  type="url"
                  value={draft.systemWebhookNew}
                  onChange={(e) => setField('systemWebhookNew', e.target.value)}
                  placeholder="https://discord.com/api/webhooks/…"
                  style={{ fontFamily: 'monospace' }}
                  autoFocus
                />
                <Button
                  icon={<DismissRegular />}
                  appearance="subtle"
                  size="small"
                  onClick={() => {
                    setField('systemWebhookNew', '');
                    setField('showSystemWebhookEdit', false);
                  }}
                >
                  Cancel change
                </Button>
                <Text className={styles.hintText}>
                  Write-only — the value is never echoed back to the UI.
                </Text>
              </div>
            )}
          </div>
        </Card>

        {/* Browser (read-only — set via env vars) */}
        <Card>
          <CardHeader image={<SettingsRegular fontSize={20} />} header={<Title3>Browser</Title3>} />
          <div className={styles.fieldGroup}>
            <Field label="Headless">
              <Input value={saved.browser.headless ? 'Yes' : 'No (headed)'} readOnly />
            </Field>
            <Field label="Persist session">
              <Input value={saved.browser.persistSession ? 'Yes' : 'No'} readOnly />
            </Field>
            <Field label="User data directory">
              <Input
                value={saved.browser.userDataDir}
                readOnly
                style={{ fontFamily: 'monospace' }}
              />
            </Field>
            <Field label="Navigation timeout">
              <Input value={`${saved.browser.gotoTimeoutMs / 1000} s`} readOnly />
            </Field>
            <Text className={styles.hintText}>
              Browser settings are configured via environment variables.
            </Text>
          </div>
        </Card>
      </div>

      {/* Sticky save bar — mobile only, shown when there are unsaved changes */}
      {dirty && (
        <div className={styles.stickyBar}>
          <Button
            icon={<ArrowCounterclockwiseRegular />}
            appearance="subtle"
            onClick={handleReset}
            disabled={saving}
          >
            Reset
          </Button>
          <Button
            icon={<SaveRegular />}
            appearance="primary"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </div>
  );
}
