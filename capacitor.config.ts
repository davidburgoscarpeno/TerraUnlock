import type { CapacitorConfig } from '@capacitor/cli';

// Fase 3 (stores): `npx cap add android` / `npx cap add ios` tras instalar Android Studio / Xcode.
// El GPS en background real requiere un plugin nativo (p. ej. @capacitor-community/background-geolocation),
// que se integrara al generar las plataformas nativas.
const config: CapacitorConfig = {
  appId: 'com.terraunlock.app',
  appName: 'TerraUnlock',
  webDir: 'dist',
  backgroundColor: '#0b1017',
};

export default config;
