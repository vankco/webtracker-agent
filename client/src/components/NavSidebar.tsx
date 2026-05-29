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
} from '@fluentui/react-icons';

const useStyles = makeStyles({
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
});

interface NavItemDef {
  to: string;
  label: string;
  icon: React.ReactNode;
  exact?: boolean;
}

const NAV_ITEMS: NavItemDef[] = [
  { to: '/', label: 'Monitor', icon: <DataUsageRegular />, exact: true },
  { to: '/providers', label: 'LLM Providers', icon: <BrainCircuitRegular /> },
  { to: '/config', label: 'Configuration', icon: <SettingsRegular /> },
];

export function NavSidebar() {
  const styles = useStyles();
  const { pathname } = useLocation();

  return (
    <nav className={styles.sidebar}>
      <Text size={100} weight="semibold" className={styles.sectionLabel} style={{ color: tokens.colorNeutralForeground3 }}>
        NAVIGATION
      </Text>
      {NAV_ITEMS.map((item) => {
        const isActive = item.exact ? pathname === item.to : pathname.startsWith(item.to);
        return (
          <NavLink
            key={item.to}
            to={item.to}
            className={mergeClasses(styles.navItem, isActive && styles.navItemActive)}
          >
            <span className={styles.icon}>{item.icon}</span>
            <Text size={300} className={styles.label}>
              {item.label}
            </Text>
          </NavLink>
        );
      })}
    </nav>
  );
}
