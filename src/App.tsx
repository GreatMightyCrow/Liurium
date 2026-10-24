import styles from "./App.module.css";
import { AppShell } from "./ui/AppShell";

function App() {
  return (
    <AppShell
      sidebar={null}
      statusBar={<span className={styles.release}>Pre-alpha</span>}
    >
      <div className={styles.placeholder}>
        <h1 className={styles.title}>Liurium</h1>
      </div>
    </AppShell>
  );
}

export default App;
