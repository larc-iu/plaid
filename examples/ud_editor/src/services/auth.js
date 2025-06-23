// Import the PlaidClient - it sets window.PlaidClient
import './plaidClient.js';
const PlaidClient = window.PlaidClient;

// Get base URL from environment or use default
const BASE_URL = import.meta.env.VITE_API_URL || window.location.origin;

let client = null;

export const authService = {
  async login(username, password) {
    try {
      // Use PlaidClient's static login method
      client = await PlaidClient.login(BASE_URL, username, password);
      
      // Extract token from the client (we'll need to store it)
      const token = client.token;
      
      // Store token and user info
      localStorage.setItem('token', token);
      localStorage.setItem('username', username);
      
      return { success: true, username };
    } catch (error) {
      console.error('Login failed:', error);
      throw error;
    }
  },

  logout() {
    client = null;
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    window.location.href = '/login';
  },

  getCurrentUser() {
    const username = localStorage.getItem('username');
    return username ? { username } : null;
  },

  getToken() {
    return localStorage.getItem('token');
  },

  isAuthenticated() {
    return !!this.getToken();
  },

  getClient() {
    const token = localStorage.getItem('token');
    if (!client && token) {
      // Recreate client from stored token
      client = new PlaidClient(BASE_URL, token);
    }
    return client;
  }
};