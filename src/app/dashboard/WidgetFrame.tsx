import { Component, type ReactNode, useId } from "react";
import styles from "./Dashboard.module.css";
import { type WidgetDefinition, WidgetProblem } from "./widget";

interface BoundaryState {
  failed: boolean;
}

// Catches a widget that throws while drawing, so the page and the other widgets
// keep working. The error text is never shown (it may hold note content); React
// itself reports it to the console. The failed body is gone, so Try again draws
// it fresh.
class WidgetBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <WidgetProblem
          text="This widget could not be shown. The other widgets still work."
          onRetry={() => {
            this.setState({ failed: false });
          }}
        />
      );
    }
    return this.props.children;
  }
}

interface WidgetFrameProps {
  widget: WidgetDefinition;
}

// One widget on the dashboard: a section named by its title, in its grid cell.
export function WidgetFrame({ widget }: WidgetFrameProps) {
  const heading = useId();
  const { Body } = widget;
  return (
    <section
      aria-labelledby={heading}
      className={styles.widget}
      data-size={widget.size}
      data-widget={widget.id}
    >
      <h2 id={heading} className={styles.title}>
        {widget.title}
      </h2>
      <WidgetBoundary>
        <Body />
      </WidgetBoundary>
    </section>
  );
}
