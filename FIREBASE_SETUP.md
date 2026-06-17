# Firebase Setup (MPQM)

## 1) Create Firebase project
1. Go to Firebase Console
2. Create project
3. Enable **Authentication > Email/Password**
4. Create **Firestore Database**:
   - Build -> Firestore Database -> **Create database**
   - Choose **Production mode**
   - Pick location closest to you (e.g. `asia-south1`)
   - Click **Enable**

## 2) Add Web app config
- Firebase Console > Project settings > General > Your apps > Web app config
- Copy values into `firebase-config.js`
- This repository already contains your provided config in `firebase-config.js`.

## 3) Firestore data model
- `profiles/{uid}`
  - `role` (string)
  - `full_name` (string)
  - `updated_at` (string timestamp)
- `app_settings/workspace`
  - `workspace_data` (map)
  - `dark_mode` (boolean)
  - `print_config` (map)
  - `credentials` (map)
  - `updated_at` (string timestamp)

## 4) Firestore Security Rules (copy/paste)
```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /app_settings/workspace {
      allow read, write: if true;
    }

    match /profiles/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## 5) First admin account
1. Open `admin-signup.html`
2. Create account
3. Login from `admin-login.html`
4. Dashboard operations will sync to `app_settings/workspace`

## 6) Quick verify (Firestore)
1. Firestore -> Data -> you should see collection `app_settings`
2. Open document `workspace`
3. Confirm fields: `workspace_data`, `dark_mode`, `print_config`, `credentials`, `updated_at`
