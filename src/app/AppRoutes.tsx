import { lazy, Suspense } from "react";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { areas } from "./areas";
import { PageErrorBoundary } from "./PageErrorBoundary";
import { PlaceholderPage } from "./PlaceholderPage";
import { useFocusPageHeading } from "./useFocusPageHeading";

// The UI gallery is for review and checks, not for users: dev server, or a build
// made with VITE_UI_GALLERY=1. Loaded lazily so normal builds leave it out.
const UiGallery =
  import.meta.env.DEV || import.meta.env.VITE_UI_GALLERY === "1"
    ? lazy(() => import("../dev/UiGallery"))
    : null;

export function AppRoutes() {
  const [location] = useLocation();
  useFocusPageHeading(location);
  return (
    // A page that fails to render shows an error state; going to another page clears it.
    <PageErrorBoundary resetKey={location}>
      <Switch>
        {areas.map((area) => (
          <Route key={area.path} path={area.path}>
            <PlaceholderPage
              title={area.label}
              icon={area.icon}
              summary={area.summary}
            />
          </Route>
        ))}
        {UiGallery !== null && (
          <Route path="/dev/ui">
            <Suspense fallback={null}>
              <UiGallery />
            </Suspense>
          </Route>
        )}
        <Route>
          <Redirect to="/" replace />
        </Route>
      </Switch>
    </PageErrorBoundary>
  );
}
