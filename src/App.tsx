import { CSPProvider } from "@base-ui/react/csp-provider";
import { useCallback, useState } from "react";
import { Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import styles from "./App.module.css";
import { AppRoutes } from "./app/AppRoutes";
import { areas } from "./app/areas";
import { CloseQuestionDialog } from "./app/CloseQuestionDialog";
import { type FrameStyle, frameStyleFrom } from "./app/frameStyle";
import { useSidebarCollapsed } from "./app/layoutChoice";
import { useSearchShortcut } from "./app/notes/searchRequest";
import { SettingsProvider } from "./app/settingsState";
import { ShowTheme } from "./app/showTheme";
import { appIconFor, applyTheme, type Theme, themeFrom } from "./app/theme";
import { useWindowControls } from "./app/useWindowControls";
import { AppShell } from "./ui/AppShell";
import { NotificationProvider } from "./ui/Notifications";
import { Sidebar } from "./ui/Sidebar";
import { TooltipProvider } from "./ui/Tooltip";
import { WindowControls } from "./ui/WindowControls";

const mainAreas = areas.filter((area) => area.placement === "main");
const endAreas = areas.filter((area) => area.placement === "end");

function App() {
  const frame = frameStyleFrom(window.location.search);
  const [theme, setTheme] = useState(() => themeFrom(window.location.search));
  const showTheme = useCallback((next: Theme) => {
    applyTheme(document.documentElement, next);
    setTheme(next);
  }, []);
  return (
    // Base UI must not insert <style> elements; our CSP blocks them (ADR-0012).
    <CSPProvider disableStyleElements>
      <ShowTheme value={showTheme}>
        <TooltipProvider>
          <NotificationProvider>
            <Router hook={useHashLocation}>
              <SettingsProvider>
                <Shell frame={frame} theme={theme} />
              </SettingsProvider>
            </Router>
          </NotificationProvider>
        </TooltipProvider>
      </ShowTheme>
    </CSPProvider>
  );
}

// Inside the router, so the sidebar can follow the page: collapsed to its icons on
// Notes, open elsewhere, each as the user last chose there (M3-014).
function Shell({ frame, theme }: { frame: FrameStyle; theme: Theme }) {
  const [location] = useLocation();
  const [collapsed, setCollapsed] = useSidebarCollapsed(location);
  useSearchShortcut();
  return (
    <AppShell
      frame={frame}
      title="Liurium"
      icon={appIconFor(theme)}
      windowControls={frame === "native" ? null : <FrameButtons />}
      sidebarCollapsed={collapsed}
      sidebar={
        <Sidebar
          title="Liurium"
          items={mainAreas}
          endItems={endAreas}
          collapsed={collapsed}
          onToggle={setCollapsed}
        />
      }
      statusBar={<span className={styles.release}>Pre-alpha</span>}
    >
      <AppRoutes />
      <CloseQuestionDialog />
    </AppShell>
  );
}

// Only mounted for the custom frames, so the native frame never calls the window API.
function FrameButtons() {
  const controls = useWindowControls();
  return (
    <WindowControls
      maximized={controls.maximized}
      onMinimize={controls.minimize}
      onToggleMaximize={controls.toggleMaximize}
      onClose={controls.close}
    />
  );
}

export default App;
