import { create } from 'zustand'
import { API_ORIGIN } from './api/client.js'

/** 服务端下发的助手配置（欢迎语等）；拉取失败时回退内置文案 */
type AssistantConfig = {
  greeting: string | null
  subtitle: string | null
}

export const useAssistantConfig = create<AssistantConfig>(() => ({
  greeting: null,
  subtitle: null,
}))

/** 启动时拉取一次；助手定位保持在服务端配置（server/persona.md） */
export const initAssistantConfig = async (): Promise<void> => {
  try {
    const response = await fetch(`${API_ORIGIN}/config`)
    if (!response.ok) {
      return
    }
    const body = (await response.json()) as { greeting?: unknown; subtitle?: unknown }
    const greeting = typeof body.greeting === 'string' && body.greeting.trim() ? body.greeting : null
    const subtitle = typeof body.subtitle === 'string' && body.subtitle.trim() ? body.subtitle : null
    if (greeting || subtitle) {
      useAssistantConfig.setState({ greeting, subtitle })
    }
  } catch {
    // 服务端配置不可用时使用内置欢迎语
  }
}
