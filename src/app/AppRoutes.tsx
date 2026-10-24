import { Redirect, Route, Switch } from "wouter";
import { areas } from "./areas";
import { PlaceholderPage } from "./PlaceholderPage";

export function AppRoutes() {
  return (
    <Switch>
      {areas.map((area) => (
        <Route key={area.path} path={area.path}>
          <PlaceholderPage title={area.label} summary={area.summary} />
        </Route>
      ))}
      <Route>
        <Redirect to="/" replace />
      </Route>
    </Switch>
  );
}
