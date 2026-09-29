import axios from 'axios';

/** All API traffic goes through the same origin (`/api`): Vite proxies it in dev, nginx in Docker. */
export const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 15_000,
});
