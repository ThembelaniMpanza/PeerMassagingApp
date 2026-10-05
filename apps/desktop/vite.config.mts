import react from '@vitejs/plugin-react';

export default {
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
};