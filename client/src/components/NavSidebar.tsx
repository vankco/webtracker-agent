import { NavLink, useLocation } from 'react-router-dom';
import {
  makeStyles,
  tokens,
  Text,
  mergeClasses,
} from '@fluentui/react-components';
import {
  DataUsageRegular,
  SettingsRegular,
  BrainCircuitRegular,
  BugRegular,
} from '@fluentui/react-icons';

const useStyles = makeStyles({
  // ── Desktop sidebar ──────────────────────────────────────────────────────────
  sidebar: {
    width: '220px',
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRightWidth: tokens.strokeWidthThin,
    borderRightStyle: 'solid',
    borderRightColor: tokens.colorNeutralStroke2,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalS}`,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    '@media (max-width: 600px)': {
      display: 'none',
    },
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    textDecoration: 'none',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    transition: 'background 0.1s',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground1Hover,
      color: tokens.colorNeutralForeground1,
    },
  },
  navItemActive: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    ':hover': {
      backgroundColor: tokens.colorBrandBackground2Hover,
    },
  },
  icon: {
    fontSize: '18px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
  },
  label: {
    userSelect: 'none',
  },
  sectionLabel: {
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalM}`,
    marginTop: tokens.spacingVerticalM,
  },

  // ── Mobile bottom tab bar ────────────────────────────────────────────────────
  bottomBar: {
    display: 'none',
    '@media (max-width: 600px)': {
      display: 'flex',
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 100,
      backgroundColor: tokens.colorNeutralBackground1,
      borderTopWidth: tokens.strokeWidthThin,
      borderTopStyle: 'solid',
      borderTopColor: tokens.colorNeutralStroke2,
      boxShadow: tokens.shadow8,
    },
  },
  tabItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    padding: `${tokens.spacingVerticalS} 0`,
    textDecoration: 'none',
    color: tokens.colorNeutralForeground3,
    gap: '2px',
    minHeight: '56px',
    ':hover': {
      color: tokens.colorNeutralForeground1,
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  tabItemActive: {
    color: tokens.colorBrandForeground1,
  },
  tabIcon: {
    fontSize: '22px',
    display: 'flex',
    alignItems: 'center',
  },
  tabLabel: {
    userSelect: 'none',
    fontSize: '10px',
    lineHeight: 1,
  },
});

interface NavItemDef {
  to: string;
  label: string;
  icon: React.ReactNode;
  exact?: boolean;
}

const NAV_ITEMS: NavItemDef[] = [
  { to: '/', label: 'Monitor', icon: <DataUsageRegular />, exact: true },
  { to: '/providers', label: 'Providers', icon: <BrainCircuitRegular /> },
  { to: '/config', label: 'Config', icon: <SettingsRegular /> },
  { to: '/debug', label: 'Debug Log', icon: <BugRegular /> },
];

export function NavSidebar() {
  const styles = useStyles();
  const { pathname } = useLocation();

  const isActive = (item: NavItemDef) =>
    item.exact ? pathname === item.to : pathname.startsWith(item.to);

  return (
    <>
      {/* Desktop sidebar */}
      <nav className={styles.sidebar}>
        <Text size={100} weight="semibold" className={styles.sectionLabel} style={{ color: tokens.colorNeutralForeground3 }}>
          NAVIGATION
        </Text>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={mergeClasses(styles.navItem, isActive(item) && styles.navItemActive)}
          >
            <span className={styles.icon}>{item.icon}</span>
            <Text size={300} className={styles.label}>{item.label}</Text>
          </NavLink>
        ))}
      </nav>

      {/* Mobile bottom tab bar */}
      <nav className={styles.bottomBar}>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={mergeClasses(styles.tabItem, isActive(item) && styles.tabItemActive)}
          >
            <span className={styles.tabIcon}>{item.icon}</span>
            <span className={styles.tabLabel}>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}
