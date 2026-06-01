# Interantio CRM

CRM de outreach para Interantio — seguimiento de contactos y empresas con Firebase Firestore.

## Setup

### 1. Firebase
1. Crear proyecto en [console.firebase.google.com](https://console.firebase.google.com)
2. Agregar app Web → copiar `firebaseConfig`
3. Habilitar **Firestore Database** (modo test inicialmente)

### 2. Variables de entorno
Crear archivo `.env` en la raíz con las credenciales de Firebase:
```
REACT_APP_FIREBASE_API_KEY=...
REACT_APP_FIREBASE_AUTH_DOMAIN=...
REACT_APP_FIREBASE_PROJECT_ID=...
REACT_APP_FIREBASE_STORAGE_BUCKET=...
REACT_APP_FIREBASE_MESSAGING_SENDER_ID=...
REACT_APP_FIREBASE_APP_ID=...
```

En Vercel: Settings → Environment Variables → agregar cada una.

### 3. Instalar y correr
```bash
npm install
npm start
```

### 4. Deploy en Vercel
Conectar repo en vercel.com → agregar variables de entorno → deploy automático.

## Firestore rules (producción)
En Firebase Console → Firestore → Rules:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true; // cambiar a auth cuando agregues login
    }
  }
}
```
