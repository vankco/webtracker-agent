import { Outlet } from 'react-router-dom';
import { makeStyles, tokens, Text } from '@fluentui/react-components';
import { NavSidebar } from './NavSidebar.js';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottomWidth: tokens.strokeWidthThin,
    borderBottomStyle: 'solid',
    borderBottomColor: tokens.colorNeutralStroke2,
    boxShadow: tokens.shadow2,
    zIndex: 10,
    gap: tokens.spacingHorizontalS,
  },
  logoMark: {
    fontSize: '20px',
    lineHeight: 1,
  },
  body: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  main: {
    flex: 1,
    overflowY: 'auto',
    padding: tokens.spacingVerticalXL,
    paddingLeft: tokens.spacingHorizontalXL,
    paddingRight: tokens.spacingHorizontalXL,
  },
});

export function AppShell() {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <span className={styles.logoMark}>🔍</span>
        <Text weight="semibold" size={400}>
          WebTracker Agent
        </Text>
      </header>
      <div className={styles.body}>
        <NavSidebar />
        <main className={styles.main}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
