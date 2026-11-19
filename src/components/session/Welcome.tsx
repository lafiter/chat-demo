import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { useAssistantConfig } from '../../services/assistantConfig.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 新对话：问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 服务端下发的助手欢迎语（server/persona.md）优先，拉取失败回退内置文案
  const greeting = useAssistantConfig((state) => state.greeting)
  const subtitle = useAssistantConfig((state) => state.subtitle)
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>{greeting ?? t('welcomeMessageChat250808')}</div>
        {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
