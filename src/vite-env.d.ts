/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" builds the UI gallery (`#/dev/ui`) into a release build, for review and checks. */
  readonly VITE_UI_GALLERY?: string;
}
