import { useEffect, useState } from "react";
import { type AppInfo, getAppInfo } from "../lib/ipc/commands";
import { type CommandError, CommandFailure } from "../lib/ipc/errors";

export type AppInfoState =
  | { status: "loading" }
  | { status: "ready"; info: AppInfo }
  | { status: "failed"; error: CommandError };

// Asks Rust once per mount; the answer does not change while the app runs.
export function useAppInfo(): AppInfoState {
  const [state, setState] = useState<AppInfoState>({ status: "loading" });

  useEffect(() => {
    let current = true;
    getAppInfo().then(
      (info) => {
        if (current) {
          setState({ status: "ready", info });
        }
      },
      (reason: unknown) => {
        if (current) {
          const error =
            reason instanceof CommandFailure
              ? reason.error
              : ({ kind: "internal" } as const);
          setState({ status: "failed", error });
        }
      },
    );
    return () => {
      current = false;
    };
  }, []);

  return state;
}
