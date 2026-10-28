import { CSPProvider } from "@base-ui/react/csp-provider";
import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import styles from "./App.module.css";
import { AppRoutes } from "./app/AppRoutes";
import { areas } from "./app/areas";
import { frameStyleFrom } from "./app/frameStyle";
import { appIconFor, themeFrom } from "./app/theme";
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
  return (
    // Base UI must not insert <style> elements; our CSP blocks them (ADR-0012).
    <CSPProvider disableStyleElements>
      <TooltipProvider>
        <NotificationProvider>
          <Router hook={useHashLocation}>
            <AppShell
              frame={frame}
              title="Liurium"
              icon={appIconFor(themeFrom(window.location.search))}
              windowControls={frame === "native" ? null : <FrameButtons />}
              sidebar={
                <Sidebar
                  title="Liurium"
                  items={mainAreas}
                  endItems={endAreas}
                />
              }
              statusBar={<span className={styles.release}>Pre-alpha</span>}
            >
              <AppRoutes />
            </AppShell>
          </Router>
        </NotificationProvider>
      </TooltipProvider>
    </CSPProvider>
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
