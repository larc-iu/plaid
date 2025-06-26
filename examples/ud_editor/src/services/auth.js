// Import the PlaidClient - it sets window.PlaidClient
import './plaidClient.js';
const PlaidClient = window.PlaidClient;

// Get base URL from environment or use default
const BASE_URL = import.meta.env.VITE_API_URL || window.location.origin;

let client = null;

// JWT parsing utility
function parseJwtPayload(token) {
  try {
    // JWT tokens have 3 parts separated by dots: header.payload.signature
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT token format');
    }
    
    // Decode the payload (second part)
    const payload = parts[1];
    // Add padding if needed for base64 decoding
    const paddedPayload = payload + '='.repeat((4 - payload.length % 4) % 4);
    const decodedPayload = atob(paddedPayload);
    
    return JSON.parse(decodedPayload);
  } catch (error) {
    console.error('Failed to parse JWT payload:', error);
    return null;
  }
}

// Extract user ID from JWT token
function getUserIdFromToken(token) {
  const payload = parseJwtPayload(token);
  return payload?.['user/id'] || null;  // Note: Clojure namespaced keyword becomes "user/id"
}

export const authService = {
  async login(username, password) {
    try {
      // Use PlaidClient's static login method
      client = await PlaidClient.login(BASE_URL, username, password);
      
      // Extract token from the client
      const token = client.token;
      
      // Extract user ID from JWT token
      const userId = getUserIdFromToken(token);
      if (!userId) {
        throw new Error('Could not extract user ID from token');
      }
      
      // Fetch complete user profile from server
      const userProfile = await client.users.get(userId);
      
      // Store token and user info
      localStorage.setItem('token', token);
      localStorage.setItem('userId', userId);
      localStorage.setItem('username', userProfile.username);
      
      return { 
        success: true, 
        user: {
          id: userId,
          username: userProfile.username,
          isAdmin: userProfile['is-admin'] || false
        }
      };
    } catch (error) {
      console.error('Login failed:', error);
      throw error;
    }
  },

  logout() {
    client = null;
    localStorage.removeItem('token');
    localStorage.removeItem('userId');
    localStorage.removeItem('username');
    window.location.href = '/login';
  },

  getCurrentUser() {
    const username = localStorage.getItem('username');
    const userId = localStorage.getItem('userId');
    const token = localStorage.getItem('token');
    
    if (!username || !userId || !token) return null;
    
    return { 
      id: userId,
      username: username,
      // Note: isAdmin status would need to be fetched from server if needed
      // For now, we'll rely on server-side permission checks
    };
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