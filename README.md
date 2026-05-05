# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## External Dependencies

This project relies on several external binaries for media processing. While some may be bundled, others must be present in the system PATH.

### Essential Components

1.  **yt-dlp**: Used for fetching video metadata and downloading.
2.  **ffmpeg / ffprobe**: Required for probing media files and merging video/audio streams during download.
    *   **Installation (Windows)**: `winget install Gyan.FFmpeg`
3.  **Deno**: **CRITICAL**. A JavaScript runtime is required for `yt-dlp` to solve YouTube signature challenges. Without this, you will likely encounter `Signature solving failed` or `403 Forbidden` errors.
    *   **Installation (Windows)**: `winget install DenoLand.Deno`

---

## Troubleshooting (YouTube Downloader)

### 1. yt-dlp version: Use Nightly
The **stable** version of yt-dlp (e.g. `2026.03.17`) cannot access most YouTube formats due to PO Token requirements. The **nightly** build includes improved client strategies (e.g. `android_vr`) that bypass these restrictions.
*   **Update to nightly**: `yt-dlp.exe --update-to nightly`
*   The bundled binary is located at `src-tauri/bin/yt-dlp.exe`.

### 2. Signature solving failed
Ensure **Deno** is installed and accessible in your terminal (`deno --version`). yt-dlp uses Deno to solve YouTube's JavaScript signature challenges.

### 3. `[Errno 22] Invalid argument` during download
Caused by **IPv6** connectivity issues with YouTube CDN on Windows. The app uses `--force-ipv4` to force all connections through IPv4.

### 4. Failed to decrypt with DPAPI (Windows)
Avoid `--cookies-from-browser` on Windows — Chrome/Edge lock the cookie database while running, and DPAPI decryption fails. The current implementation avoids cookies entirely.

### 5. HTTP Error 429: Too Many Requests
Usually resolved by having Deno installed (for JS challenge solving) and using the nightly build. If it persists, you may need to manually export cookies to a `.txt` file.
