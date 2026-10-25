import { Component, type ReactNode } from "react";
import { Button } from "../ui/Button";
import { ErrorState } from "../ui/StateView";

interface PageErrorBoundaryProps {
  /** The current route. A new value clears the error, so other pages keep working. */
  resetKey: string;
  /** Defaults to reloading the window. */
  onReload?: () => void;
  children: ReactNode;
}

interface PageErrorBoundaryState {
  failed: boolean;
  resetKey: string;
}

function reloadWindow() {
  window.location.reload();
}

// Catches render errors of the current page, so a broken page never leaves a blank
// window. The error text is never shown (it may contain note content); React itself
// reports the error to the console.
export class PageErrorBoundary extends Component<
  PageErrorBoundaryProps,
  PageErrorBoundaryState
> {
  state: PageErrorBoundaryState = {
    failed: false,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(): Partial<PageErrorBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: PageErrorBoundaryProps,
    state: PageErrorBoundaryState,
  ): Partial<PageErrorBoundaryState> | null {
    return props.resetKey === state.resetKey
      ? null
      : { failed: false, resetKey: props.resetKey };
  }

  render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <ErrorState
        title="This page could not be shown"
        description="Something went wrong while drawing this page. Other pages still work. Reloading starts Liurium's window fresh."
        action={
          <Button onClick={this.props.onReload ?? reloadWindow}>
            Reload Liurium
          </Button>
        }
      />
    );
  }
}
