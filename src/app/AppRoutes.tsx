import { lazy, Suspense } from "react";
import { Redirect, Route, Switch } from "wouter";
import { areas } from "./areas";
import { PlaceholderPage } from "./PlaceholderPage";

// The UI gallery is for review and checks, not for users: dev server, or a build
// made with VITE_UI_GALLERY=1. Loaded lazily so normal builds leave it out.
const UiGallery =
  import.meta.env.DEV || import.meta.env.VITE_UI_GALLERY === "1"
    ? lazy(() => import("../dev/UiGallery"))
    : null;

export function AppRoutes() {
  return (
    <Switch>
      {areas.map((area) => (
        <Route key={area.path} path={area.path}>
          <PlaceholderPage title={area.label} summary={area.summary} />
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
  );
}
