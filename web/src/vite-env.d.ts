/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override when the API is not on the default tunnel port. */
  readonly VITE_API?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
