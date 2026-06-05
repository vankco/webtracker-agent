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
} from '@fluentui/react-icons';
import { api, ApiError } from '../api/client.js';
import type { SafeAppConfig, PutConfigRequest } from '../api/types.js';

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
  emptyState: {
    textAlign: 'center',
    padding: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForeground3,
  },
});

interface Draft {
  targetUrl: string;
  targetSelector: string;
  intervalSeconds: string;
  runOnce: boolean;
  webhookNew: string;
  showWebhookEdit: boolean;
  systemWebhookNew: string;
  showSystemWebhookEdit: boolean;
}

function toDraft(config: SafeAppConfig): Draft {
  return {
    targetUrl: config.target.url,
    targetSelector: config.target.selector,
    intervalSeconds: String(Math.round(config.schedule.intervalMs / 1000)),
    runOnce: config.schedule.runOnce,
    webhookNew: '',
    showWebhookEdit: false,
    systemWebhookNew: '',
    showSystemWebhookEdit: false,
  };
}

function isDirty(draft: Draft, saved: SafeAppConfig): boolean {
  const intervalMs = (parseInt(draft.intervalSeconds, 10) || 0) * 1000;
  return (
    draft.targetUrl !== saved.target.url ||
    draft.targetSelector !== saved.target.selector ||
    intervalMs !== saved.schedule.intervalMs ||
    draft.runOnce !== saved.schedule.runOnce ||
    draft.webhookNew.trim() !== '' ||
    draft.systemWebhookNew.trim() !== ''
  );
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
        target: { url: draft.targetUrl.trim(), selector: draft.targetSelector.trim() },
        schedule: { intervalMs, runOnce: draft.runOnce },
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
    <div className={styles.root}>
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

      <div className={styles.cardGrid}>
        {/* Target */}
        <Card>
          <CardHeader image={<GlobeRegular fontSize={20} />} header={<Title3>Target</Title3>} />
          <div className={styles.fieldGroup}>
            <Field label="URL" required>
              <Input
                value={draft.targetUrl}
                onChange={(e) => setField('targetUrl', e.target.value)}
                placeholder="https://example.com"
                style={{ fontFamily: 'monospace' }}
              />
            </Field>
            <Field label="CSS Selector">
              <Input
                value={draft.targetSelector}
                onChange={(e) => setField('targetSelector', e.target.value)}
                placeholder="(entire page)"
                style={{ fontFamily: 'monospace' }}
              />
            </Field>
            <Text className={styles.hintText}>
              Leave selector blank to monitor the full page body.
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
    </div>
  );
}
