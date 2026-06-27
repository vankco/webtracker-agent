import { useState, useEffect, useCallback } from 'react';
import {
  makeStyles,
  tokens,
  Title2,
  Title3,
  Body1,
  Caption1,
  Button,
  Badge,
  Card,
  CardHeader,
  Spinner,
  Divider,
  Text,
  Field,
  Input,
  Switch,
  MessageBar,
  MessageBarBody,
} from '@fluentui/react-components';
import {
  PlayRegular,
  StopRegular,
  ArrowSyncRegular,
  CheckmarkCircleRegular,
  DismissCircleRegular,
  WarningRegular,
  ClockRegular,
  GlobeSearchRegular,
  TimerRegular,
} from '@fluentui/react-icons';
import { api, ApiError } from '../api/client.js';
import type { MultiSiteMonitorStatus, SiteStatusView, ValidateScrapeResponse, ContentSnapshot } from '../api/types.js';

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
  titleGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  actions: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
  },
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: tokens.spacingVerticalM,
    '@media (max-width: 600px)': {
      gridTemplateColumns: '1fr',
    },
  },
  statCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  statValue: {
    fontVariantNumeric: 'tabular-nums',
  },
  resultCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  resultMeta: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
    alignItems: 'center',
  },
  summaryText: {
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    fontFamily: 'monospace',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  errorList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    maxHeight: '200px',
    overflowY: 'auto',
  },
  errorItem: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    alignItems: 'flex-start',
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    backgroundColor: tokens.colorStatusDangerBackground1,
    borderRadius: tokens.borderRadiusMedium,
  },
  errorTimestamp: {
    flexShrink: 0,
    color: tokens.colorNeutralForeground3,
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
  emptyState: {
    textAlign: 'center',
    padding: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForeground3,
  },
  controlsRow: {
    display: 'flex',
    gap: tokens.spacingHorizontalM,
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    '@media (max-width: 600px)': {
      flexDirection: 'column',
      alignItems: 'stretch',
    },
  },
  controlsFieldFixed180: {
    flex: '0 0 180px',
    '@media (max-width: 600px)': {
      flex: '1 1 auto',
    },
  },
  controlsFieldFixed200: {
    flex: '0 0 200px',
    '@media (max-width: 600px)': {
      flex: '1 1 auto',
    },
  },
  scrapeSnippet: {
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    fontFamily: 'monospace',
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: '200px',
    overflowY: 'auto',
  },
  siteList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  siteItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    cursor: 'pointer',
    textAlign: 'left',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  siteItemSelected: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground1Selected,
  },
  siteItemMain: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    overflow: 'hidden',
  },
  siteUrl: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '420px',
  },
});

function formatTime(iso: string | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString();
}

function formatRelative(iso: string | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

export function MonitorPage() {
  const styles = useStyles();

  // Monitor status
  const [status, setStatus] = useState<MultiSiteMonitorStatus | null>(null);
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Schedule controls
  const [scheduleInterval, setScheduleInterval] = useState('');
  const [scheduleRunOnce, setScheduleRunOnce] = useState(false);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleMsg, setScheduleMsg] = useState<string | null>(null);

  // Scrape validator
  const [scrapeUrl, setScrapeUrl] = useState('');
  const [scrapeSelector, setScrapeSelector] = useState('');
  const [scrapeTesting, setScrapeTesting] = useState(false);
  const [scrapeResult, setScrapeResult] = useState<ValidateScrapeResponse | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await api.monitor.status();
      setStatus(s);
      setErrorMsg(null);
      const ids = Object.keys(s.sites);
      // Keep the current selection if still valid; otherwise select the first site.
      setSelectedSiteId((prev) => (prev && ids.includes(prev) ? prev : ids[0] ?? null));
      // Pre-fill scrape URL from the (first) site if not already set by user
      setScrapeUrl((prev) => prev || Object.values(s.sites)[0]?.url || '');
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : 'Failed to load status.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load config for schedule defaults
  useEffect(() => {
    void (async () => {
      try {
        const config = await api.config.get();
        setScheduleInterval(String(Math.round(config.schedule.intervalMs / 1000)));
        setScheduleRunOnce(config.schedule.runOnce);
      } catch {
        // Non-fatal — defaults stay empty
      }
    })();
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Auto-refresh: 5 s when running, 15 s when stopped
  useEffect(() => {
    const interval = setInterval(() => {
      void fetchStatus();
    }, status?.running ? 5_000 : 15_000);
    return () => clearInterval(interval);
  }, [status?.running, fetchStatus]);

  async function handleStart() {
    setActionLoading(true);
    try {
      await api.monitor.start();
      await fetchStatus();
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : 'Failed to start monitor.');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleStop() {
    setActionLoading(true);
    try {
      await api.monitor.stop();
      await fetchStatus();
    } catch (err) {
      setErrorMsg(err instanceof ApiError ? err.message : 'Failed to stop monitor.');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleScheduleSave() {
    const intervalMs = (parseInt(scheduleInterval, 10) || 0) * 1000;
    if (intervalMs < 1000) {
      setScheduleMsg('Interval must be at least 1 second.');
      return;
    }
    setScheduleSaving(true);
    setScheduleMsg(null);
    try {
      await api.config.update({ schedule: { intervalMs, runOnce: scheduleRunOnce } });
      setScheduleMsg('Schedule updated.');
    } catch (err) {
      setScheduleMsg(err instanceof ApiError ? err.message : 'Failed to update schedule.');
    } finally {
      setScheduleSaving(false);
    }
  }

  async function handleScrapeTest() {
    if (!scrapeUrl.trim()) return;
    setScrapeTesting(true);
    setScrapeResult(null);
    try {
      const result = await api.validate.scrape({
        url: scrapeUrl.trim(),
        selector: scrapeSelector.trim() || undefined,
      });
      setScrapeResult(result);
    } catch (err) {
      setScrapeResult({
        success: false,
        error: err instanceof ApiError ? err.message : 'Scrape failed.',
        latencyMs: 0,
      });
    } finally {
      setScrapeTesting(false);
    }
  }

  if (loading) {
    return (
      <div className={styles.emptyState}>
        <Spinner label="Loading monitor status…" />
      </div>
    );
  }

  const running = status?.running ?? false;
  const siteList: SiteStatusView[] = status ? Object.values(status.sites) : [];
  const selectedSite: SiteStatusView | undefined =
    (selectedSiteId ? status?.sites[selectedSiteId] : undefined) ?? siteList[0];
  const lastResult = selectedSite?.lastResult;

  const siteBadge = (s: SiteStatusView) => {
    if (s.errors.length > 0) return <Badge appearance="filled" color="danger">error</Badge>;
    if (s.lastResult?.changed) return <Badge appearance="filled" color="warning">changed</Badge>;
    if (s.lastResult) return <Badge appearance="filled" color="success">no change</Badge>;
    return <Badge appearance="outline" color="informative">idle</Badge>;
  };

  return (
    <div className={styles.root}>
      {/* Title + start/stop */}
      <div className={styles.titleRow}>
        <div className={styles.titleGroup}>
          <Title2>Monitor</Title2>
          <Badge appearance="filled" color={running ? 'success' : 'informative'} size="large">
            {running ? 'Running' : 'Stopped'}
          </Badge>
        </div>

        <div className={styles.actions}>
          {errorMsg && (
            <Caption1 style={{ color: tokens.colorStatusDangerForeground1 }}>{errorMsg}</Caption1>
          )}
          <Button
            icon={<ArrowSyncRegular />}
            appearance="subtle"
            onClick={() => void fetchStatus()}
            disabled={actionLoading}
          >
            Refresh
          </Button>
          {running ? (
            <Button
              icon={<StopRegular />}
              appearance="secondary"
              onClick={() => void handleStop()}
              disabled={actionLoading}
            >
              Stop
            </Button>
          ) : (
            <Button
              icon={<PlayRegular />}
              appearance="primary"
              onClick={() => void handleStart()}
              disabled={actionLoading}
            >
              Start
            </Button>
          )}
          {actionLoading && <Spinner size="tiny" />}
        </div>
      </div>

      <Divider />

      {/* Tracked sites */}
      {siteList.length > 0 && (
        <Card>
          <CardHeader
            header={
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                <Title3>Tracked Sites</Title3>
                <Badge appearance="outline" color="informative">{siteList.length}</Badge>
              </div>
            }
          />
          <div className={styles.siteList}>
            {siteList.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`${styles.siteItem} ${s.id === selectedSite?.id ? styles.siteItemSelected : ''}`}
                onClick={() => setSelectedSiteId(s.id)}
              >
                <div className={styles.siteItemMain}>
                  <Body1>{s.label || s.url}</Body1>
                  <Caption1 className={`${styles.muted} ${styles.siteUrl}`} title={s.url}>{s.url}</Caption1>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS }}>
                  {!s.enabled && <Badge appearance="outline" color="subtle">disabled</Badge>}
                  {siteBadge(s)}
                </div>
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Stat cards */}
      <div className={styles.cardGrid}>
        <Card>
          <div className={styles.statCard}>
            <Caption1 className={styles.muted}>
              <ClockRegular style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Last Check
            </Caption1>
            <Title3 className={styles.statValue}>{formatTime(selectedSite?.lastCheck)}</Title3>
            {selectedSite?.lastCheck && (
              <Caption1 className={styles.muted}>{formatRelative(selectedSite.lastCheck)}</Caption1>
            )}
          </div>
        </Card>

        <Card>
          <div className={styles.statCard}>
            <Caption1 className={styles.muted}>
              <ClockRegular style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Next Check
            </Caption1>
            <Title3 className={styles.statValue}>
              {running ? formatTime(selectedSite?.nextCheck) : '—'}
            </Title3>
            {running && selectedSite?.nextCheck && (
              <Caption1 className={styles.muted}>
                in {formatRelative(selectedSite.nextCheck).replace(' ago', '')}
              </Caption1>
            )}
          </div>
        </Card>

        <Card>
          <div className={styles.statCard}>
            <Caption1 className={styles.muted}>Site URL</Caption1>
            <Body1
              className={styles.statValue}
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={selectedSite?.url}
            >
              {selectedSite?.url || '—'}
            </Body1>
          </div>
        </Card>
      </div>

      {/* Last result */}
      {lastResult && (
        <Card>
          <CardHeader
            header={
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                <Title3>Last Result</Title3>
                {lastResult.changed ? (
                  <Badge appearance="filled" color="warning" icon={<WarningRegular />}>Changed</Badge>
                ) : (
                  <Badge appearance="filled" color="success" icon={<CheckmarkCircleRegular />}>No Change</Badge>
                )}
                {lastResult.fallback && (
                  <Badge appearance="outline" color="informative">Local Fallback</Badge>
                )}
              </div>
            }
          />
          <div className={styles.resultCard}>
            <div className={styles.resultMeta}>
              {lastResult.provider && lastResult.provider !== 'none' && (
                <Caption1>
                  Provider: <strong>{lastResult.provider}</strong>
                  {lastResult.model && ` / ${lastResult.model}`}
                </Caption1>
              )}
              {lastResult.latencyMs !== undefined && (
                <Caption1 className={styles.muted}>{lastResult.latencyMs}ms</Caption1>
              )}
            </div>
            <div className={styles.summaryText}>{lastResult.summary}</div>
          </div>
        </Card>
      )}

      {/* Errors */}
      {selectedSite && selectedSite.errors.length > 0 && (
        <Card>
          <CardHeader
            header={
              <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
                <Title3>Recent Errors</Title3>
                <Badge appearance="filled" color="danger">{selectedSite.errors.length}</Badge>
              </div>
            }
          />
          <div className={styles.errorList}>
            {[...selectedSite.errors].reverse().map((e, i) => (
              <div key={i} className={styles.errorItem}>
                <DismissCircleRegular
                  style={{ color: tokens.colorStatusDangerForeground1, flexShrink: 0, marginTop: 2 }}
                />
                <div>
                  <Caption1 className={styles.errorTimestamp}>
                    {new Date(e.timestamp).toLocaleTimeString()}
                  </Caption1>
                  <Body1> {e.message}</Body1>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {!lastResult && !loading && (
        <Card>
          <div className={styles.emptyState}>
            <Text>No checks have run yet. Start the monitor to begin tracking.</Text>
          </div>
        </Card>
      )}

      {/* Recent content snapshots */}
      {selectedSite && selectedSite.recentSnapshots.length > 0 && (
        <Card>
          <CardHeader header={<Title3>Recent Fetched Content</Title3>} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
            {selectedSite.recentSnapshots.slice(0, 1).map((snap: ContentSnapshot, i: number) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: tokens.spacingHorizontalS }}>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    Latest — {new Date(snap.fetchedAt).toLocaleTimeString()}
                  </Caption1>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                    {snap.contentLength.toLocaleString()} chars
                  </Caption1>
                </div>
                <div className={styles.summaryText}>{snap.preview}{snap.contentLength > 500 ? '…' : ''}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Divider />

      {/* Schedule controls */}
      <Card>
        <CardHeader
          image={<TimerRegular fontSize={20} />}
          header={<Title3>Schedule Controls</Title3>}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
          <div className={styles.controlsRow}>
            <Field label="Check interval (seconds)" className={styles.controlsFieldFixed180}>
              <Input
                type="number"
                value={scheduleInterval}
                onChange={(e) => { setScheduleInterval(e.target.value); setScheduleMsg(null); }}
                min={1}
              />
            </Field>
            <Field label="Run-once mode">
              <Switch
                checked={scheduleRunOnce}
                onChange={(_e, data) => { setScheduleRunOnce(data.checked); setScheduleMsg(null); }}
                label={scheduleRunOnce ? 'On' : 'Off'}
              />
            </Field>
            <Button
              appearance="primary"
              size="small"
              onClick={() => void handleScheduleSave()}
              disabled={scheduleSaving}
            >
              {scheduleSaving ? 'Applying…' : 'Apply'}
            </Button>
          </div>
          {scheduleMsg && (
            <Caption1
              style={{
                color: scheduleMsg.includes('updated')
                  ? tokens.colorStatusSuccessForeground1
                  : tokens.colorStatusDangerForeground1,
              }}
            >
              {scheduleMsg}
            </Caption1>
          )}
          <Caption1 className={styles.muted}>
            Changes take effect on the next check cycle. Running monitor is not restarted.
          </Caption1>
        </div>
      </Card>

      {/* Scrape validator */}
      <Card>
        <CardHeader
          image={<GlobeSearchRegular fontSize={20} />}
          header={<Title3>Scrape Validator</Title3>}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
          <div className={styles.controlsRow}>
            <Field label="URL" style={{ flex: 1 }}>
              <Input
                type="url"
                value={scrapeUrl}
                onChange={(e) => setScrapeUrl(e.target.value)}
                placeholder="https://example.com"
                style={{ fontFamily: 'monospace' }}
              />
            </Field>
            <Field label="CSS Selector (optional)" className={styles.controlsFieldFixed200}>
              <Input
                value={scrapeSelector}
                onChange={(e) => setScrapeSelector(e.target.value)}
                placeholder="main, #prices, …"
                style={{ fontFamily: 'monospace' }}
              />
            </Field>
            <Button
              appearance="primary"
              size="small"
              disabled={!scrapeUrl.trim() || scrapeTesting}
              icon={scrapeTesting ? <Spinner size="tiny" /> : undefined}
              onClick={() => void handleScrapeTest()}
            >
              {scrapeTesting ? 'Testing…' : 'Test Scrape'}
            </Button>
          </div>

          {scrapeResult && (
            <>
              {scrapeResult.success ? (
                <MessageBar intent="success">
                  <MessageBarBody>
                    Scraped {scrapeResult.contentLength?.toLocaleString()} chars in {scrapeResult.latencyMs}ms
                  </MessageBarBody>
                </MessageBar>
              ) : (
                <MessageBar intent="error">
                  <MessageBarBody>{scrapeResult.error ?? 'Scrape failed.'}</MessageBarBody>
                </MessageBar>
              )}
              {scrapeResult.snippet && (
                <div>
                  <Caption1 className={styles.muted}>Content preview (first 500 chars):</Caption1>
                  <div className={styles.scrapeSnippet}>{scrapeResult.snippet}</div>
                </div>
              )}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
