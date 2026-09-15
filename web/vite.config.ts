import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The API runs on the VM and is reached through an SSH tunnel:
//   ssh -L 8090:127.0.0.1:8090 ubuntu@blankpoint.club
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
})
