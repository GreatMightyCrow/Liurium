import { Toast } from "@base-ui/react/toast";
import { CircleCheck, CircleX, Info, X, type LucideIcon } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { IconButton } from "./IconButton";
import styles from "./Notifications.module.css";

export type NotificationTone = "info" | "success" | "error";

export interface Notification {
  tone: NotificationTone;
  title: string;
  description?: string;
}

interface NotificationData {
  tone: NotificationTone;
}

interface ToneBehavior {
  icon: LucideIcon;
  /** Milliseconds until it closes by itself; 0 keeps it until dismissed. */
  timeout: number;
  /** low: read out when the screen reader is idle; high: read out at once. */
  priority: "low" | "high";
}

// Confirmations close by themselves. Errors stay until the user has read and
// dismissed them, and interrupt the screen reader.
const tones: Record<NotificationTone, ToneBehavior> = {
  info: { icon: Info, timeout: 5000, priority: "low" },
  success: { icon: CircleCheck, timeout: 5000, priority: "low" },
  error: { icon: CircleX, timeout: 0, priority: "high" },
};

// Wraps the app once. Notifications appear bottom right, above the status bar;
// F6 moves keyboard focus to them (Base UI).
export function NotificationProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider>
      {children}
      <Toast.Portal>
        <Toast.Viewport className={styles.viewport}>
          <NotificationList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function NotificationList() {
  const { toasts } = Toast.useToastManager<NotificationData>();
  return toasts.map((toast) => {
    const tone = toast.data?.tone ?? "info";
    const Icon = tones[tone].icon;
    return (
      <Toast.Root
        key={toast.id}
        toast={toast}
        className={[styles.toast, styles[tone]].join(" ")}
      >
        <Icon className={styles.icon} strokeWidth={1.5} aria-hidden />
        <Toast.Content className={styles.content}>
          <Toast.Title className={styles.title} />
          <Toast.Description className={styles.description} />
        </Toast.Content>
        <Toast.Close
          render={
            <IconButton
              icon={X}
              label="Dismiss notification"
              size="sm"
              className={styles.close}
            />
          }
        />
      </Toast.Root>
    );
  });
}

/** Shows a notification. Needs a `NotificationProvider` above. */
export function useNotify(): (notification: Notification) => void {
  const { add } = Toast.useToastManager<NotificationData>();
  return useCallback(
    ({ tone, title, description }: Notification) => {
      add({
        title,
        description,
        timeout: tones[tone].timeout,
        priority: tones[tone].priority,
        data: { tone },
      });
    },
    [add],
  );
}
