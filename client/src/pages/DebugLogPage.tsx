import { useState, useEffect, useCallback } from 'react';
import {
  makeStyles,
  tokens,
  Title2,
  Caption1,
  Body1,
  Badge,
  Card,
  Button,
  Spinner,
  Select,
  Field,
} from '@fluentui/react-components';
import {
  DeleteRegular,
  ArrowSyncRegular,
} from '@fluentui/react-icons';
import { api, ApiError } from '../api/client.js';
import type { LogEntry, LogLevel, LogCategory } from '../api/types.js';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    maxWidth: '1000px',
    width: '100%',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
  logList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  entry: {
    display: 'grid',
    gridTemplateColumns: '140px 60px 72px 1fr',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusSmall,
    alignItems: 'start',
    '@media (max-width: 600px)': {
      gridTemplateColumns: '1fr',
    },
  },
  entryInfo: {
    backgroundColor: tokens.colorNeutralBackground2,
  },
  entryWarn: {
    backgroundColor: tokens.colorStatusWarningBackground1,
  },
  entryError: {
    backgroundColor: tokens.colorStatusDangerBackground1,
  },
  timestamp: {
    fontFamily: 'monospace',
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
  },
  message: {
    fontSize: tokens.fontSizeBase200,
    wordBreak: 'break-word',
  },
  details: {
    gridColumn: '2 / -1',
    fontFamily: 'monospace',
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    marginTop: '2px',
    '@media (max-width: 600px)': {
      gridColumn: '1',
    },
  },
  emptyState: {
    textAlign: 'center',
    padding: tokens.spacingVerticalXXL,
    color: tokens.colorNeutralForeground3,
  },
  count: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
});

const LEVEL_COLORS: Record<LogLevel, 'success' | 'warning' | 'danger' | 'informative'> = {
  info: 'informative',
  warn: 'warning',
  error: 'danger',
};

const CATEGORY_COLORS: Record<LogCategory, 'brand' | 'informative' | 'success' | 'warning' | 'danger'> = {
  scrape:  'brand',
  llm:     'success',
  monitor: 'informative',
  config:  'warning',
  system:  'danger',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString() + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export function DebugLogPage() {
  const styles = useStyles();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<LogCategory | 'all'>('all');
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [clearing, setClearing] = useState(false);

  const fetchLogs = useCallback(async () => {
    try {
      const logs = await api.logs.get();
      setEntries(logs);
    } catch (err) {
      console.error(err instanceof ApiError ? err.message : err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchLogs(); }, [fetchLogs]);

  // Auto-refresh every 5s
  useEffect(() => {
    const t = setInterval(() => void fetchLogs(), 5_000);
    return () => clearInterval(t);
  }, [fetchLogs]);

  async function handleClear() {
    setClearing(true);
    try {
      await api.logs.clear();
      setEntries([]);
      setExpandedIds(new Set());
    } finally {
      setClearing(false);
    }
  }

  function toggleExpand(id: number) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const filtered = entries.filter(e =>
    (levelFilter === 'all' || e.level === levelFilter) &&
    (categoryFilter === 'all' || e.category === categoryFilter)
  );

  return (
    <div className={styles.root}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: tokens.spacingHorizontalM }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM }}>
          <Title2>Debug Log</Title2>
          <span className={styles.count}>{filtered.length} entries</span>
        </div>
        <div style={{ display: 'flex', gap: tokens.spacingHorizontalS }}>
          <Button icon={<ArrowSyncRegular />} appearance="subtle" size="small" onClick={() => void fetchLogs()}>
            Refresh
          </Button>
          <Button icon={clearing ? <Spinner size="tiny" /> : <DeleteRegular />} appearance="outline" size="small" onClick={() => void handleClear()} disabled={clearing}>
            Clear
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className={styles.toolbar}>
        <Field label="Level" style={{ minWidth: '100px' }}>
          <Select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value as LogLevel | 'all')}>
            <option value="all">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </Select>
        </Field>
        <Field label="Category" style={{ minWidth: '130px' }}>
          <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value as LogCategory | 'all')}>
            <option value="all">All categories</option>
            <option value="scrape">Scrape</option>
            <option value="llm">LLM</option>
            <option value="monitor">Monitor</option>
            <option value="config">Config</option>
            <option value="system">System</option>
          </Select>
        </Field>
      </div>

      <Card>
        {loading ? (
          <div className={styles.emptyState}><Spinner label="Loading logs…" /></div>
        ) : filtered.length === 0 ? (
          <div className={styles.emptyState}>
            <Body1>No log entries{levelFilter !== 'all' || categoryFilter !== 'all' ? ' matching filters' : ''}. Start the monitor to see activity.</Body1>
          </div>
        ) : (
          <div className={styles.logList}>
            {filtered.map((entry) => {
              const hasDetails = entry.details && Object.keys(entry.details).length > 0;
              const isExpanded = expandedIds.has(entry.id);
              const rowStyle = entry.level === 'error' ? styles.entryError : entry.level === 'warn' ? styles.entryWarn : styles.entryInfo;
              return (
                <div
                  key={entry.id}
                  className={`${styles.entry} ${rowStyle}`}
                  onClick={hasDetails ? () => toggleExpand(entry.id) : undefined}
                  style={hasDetails ? { cursor: 'pointer' } : undefined}
                >
                  <Caption1 className={styles.timestamp}>{formatTime(entry.timestamp)}</Caption1>
                  <Badge appearance="outline" color={LEVEL_COLORS[entry.level]} size="small">
                    {entry.level}
                  </Badge>
                  <Badge appearance="tint" color={CATEGORY_COLORS[entry.category]} size="small">
                    {entry.category}
                  </Badge>
                  <span className={styles.message}>
                    {entry.message}
                    {hasDetails && (
                      <Caption1 style={{ marginLeft: 4, color: tokens.colorNeutralForeground3 }}>
                        {isExpanded ? '▾' : '▸'}
                      </Caption1>
                    )}
                  </span>
                  {hasDetails && isExpanded && (
                    <div className={styles.details}>
                      {JSON.stringify(entry.details, null, 2)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
