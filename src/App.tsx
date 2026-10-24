import { Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import styles from "./App.module.css";
import { AppRoutes } from "./app/AppRoutes";
import { areas } from "./app/areas";
import { AppShell } from "./ui/AppShell";
import { Sidebar } from "./ui/Sidebar";

const mainAreas = areas.filter((area) => area.placement === "main");
const endAreas = areas.filter((area) => area.placement === "end");

function App() {
  return (
    <Router hook={useHashLocation}>
      <AppShell
        sidebar={
          <Sidebar title="Liurium" items={mainAreas} endItems={endAreas} />
        }
        statusBar={<span className={styles.release}>Pre-alpha</span>}
      >
        <AppRoutes />
      </AppShell>
    </Router>
  );
}

export default App;
