import { useEffect } from "react";
import { Redirect } from "wouter";
import { requestSearch } from "./notes/searchRequest";

// The sidebar's Search leads to the Search tab of the Notes page (M4-002, owner
// decision): search sits next to Files and Tags, as in Obsidian.
export function SearchRoute() {
  useEffect(() => {
    requestSearch();
  }, []);
  return <Redirect to="/notes" replace />;
}
