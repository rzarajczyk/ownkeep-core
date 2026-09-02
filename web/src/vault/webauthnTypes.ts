export {}

declare global {
  interface PublicKeyCredentialCreationOptions {
    hints?: string[]
  }

  interface PublicKeyCredentialRequestOptions {
    hints?: string[]
  }
}
