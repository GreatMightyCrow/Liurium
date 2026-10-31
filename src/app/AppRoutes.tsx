import { type ComponentType, lazy, Suspense } from "react";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { areas } from "./areas";
import { PageErrorBoundary } from "./PageErrorBoundary";
import { PlaceholderPage } from "./PlaceholderPage";
import { SettingsPage } from "./SettingsPage";
import { useFocusPageHeading } from "./useFocusPageHeading";

// Areas with a real page; the others show their placeholder.
const pages: Partial<Record<string, ComponentType>> = {
  "/settings": SettingsPage,
};

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
        {areas.map((area) => {
          const Page = pages[area.path];
          return (
            <Route key={area.path} path={area.path}>
              {Page === undefined ? (
                <PlaceholderPage
                  title={area.label}
                  icon={area.icon}
                  summary={area.summary}
                />
              ) : (
                <Page />
              )}
            </Route>
          );
        })}
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
