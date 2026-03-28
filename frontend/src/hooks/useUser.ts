import { useState, useEffect, useCallback } from 'react'

export interface User {
  email: string
  name: string
  preferences: string | null
}

export function useUser() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchUser = useCallback(async () => {
    try {
      const res = await fetch('/api/user')
      if (res.ok) {
        const data = await res.json()
        setUser(data)
      } else {
        setUser(null)
      }
    } catch (err) {
      console.error('Failed to fetch user:', err)
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchUser()
  }, [fetchUser])

  const setPreferences = async (preferences: string) => {
    try {
      const res = await fetch('/api/user/preferences', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ preferences })
      })
      
      if (res.ok) {
        setUser(prev => prev ? { ...prev, preferences } : null)
        return true
      }
      return false
    } catch (err) {
      console.error('Failed to save preferences:', err)
      return false
    }
  }

  return { user, loading, setPreferences }
}
