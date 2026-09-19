/* i18n.js — Nyxie interface localization.
 * Languages are stored locally so the choice survives refreshes.
 * Static UI text is translated automatically when its exact English
 * label is present in the dictionary; new/dynamic UI can use data-i18n
 * or window.t('English text').
 */
(function () {
  const LANG_KEY = 'nyxie_language';

  const LANGUAGES = [
    { code: 'en', name: 'English', native: 'English', flag: '🇬🇧', dir: 'ltr' },
    { code: 'es', name: 'Spanish', native: 'Español', flag: '🇪🇸', dir: 'ltr' },
    { code: 'fr', name: 'French', native: 'Français', flag: '🇫🇷', dir: 'ltr' },
    { code: 'de', name: 'German', native: 'Deutsch', flag: '🇩🇪', dir: 'ltr' },
    { code: 'pt', name: 'Portuguese', native: 'Português', flag: '🇵🇹', dir: 'ltr' },
    { code: 'it', name: 'Italian', native: 'Italiano', flag: '🇮🇹', dir: 'ltr' },
    { code: 'tr', name: 'Turkish', native: 'Türkçe', flag: '🇹🇷', dir: 'ltr' },
    { code: 'ar', name: 'Arabic', native: 'العربية', flag: '🇸🇦', dir: 'rtl' },
    { code: 'ru', name: 'Russian', native: 'Русский', flag: '🇷🇺', dir: 'ltr' },
    { code: 'ja', name: 'Japanese', native: '日本語', flag: '🇯🇵', dir: 'ltr' },
    { code: 'ko', name: 'Korean', native: '한국어', flag: '🇰🇷', dir: 'ltr' },
    { code: 'zh', name: 'Chinese (Simplified)', native: '简体中文', flag: '🇨🇳', dir: 'ltr' },
    { code: 'am', name: 'Amharic', native: 'አማርኛ', flag: '🇪🇹', dir: 'ltr' }
  ];

  // The dictionary intentionally uses English source text as the key. This
  // lets existing Nyxie markup be localized without rewriting every view.
  const D = {
    es: {
      'Settings':'Ajustes','Profile':'Perfil','Account':'Cuenta','Appearance':'Apariencia','Privacy':'Privacidad','Security':'Seguridad','Notifications':'Notificaciones','Language':'Idioma','Sync':'Sincronización','Experiments':'Experimentos','My Bots':'Mis bots','Feedback':'Comentarios','Changelogs':'Cambios','Source Code':'Código fuente','Donate':'Donar',
      'Back':'Atrás','Save Changes':'Guardar cambios','Cancel':'Cancelar','Save':'Guardar','Reset':'Restablecer','Close':'Cerrar','Logout':'Cerrar sesión','Search':'Buscar','Friends':'Amigos','Home':'Inicio','Wallet':'Billetera','Marketplace':'Mercado','Servers':'Servidores','Messages':'Mensajes','Notifications':'Notificaciones',
      'Change Username':'Cambiar nombre de usuario','Change Email':'Cambiar correo','Change Password':'Cambiar contraseña','Display Name':'Nombre visible','Bio':'Biografía','Username':'Nombre de usuario','Email':'Correo electrónico','Password':'Contraseña',
      'Theme':'Tema','Accent Color':'Color de acento','Font':'Fuente','Custom Accent Color':'Color de acento personalizado','Light':'Claro','Dark':'Oscuro','System':'Sistema',
      'Enable Notifications':'Activar notificaciones','Notification Sounds':'Sonidos de notificación','Language settings':'Configuración de idioma','Choose the language you want to use across Nyxie.':'Elige el idioma que quieres usar en Nyxie.','Interface Language':'Idioma de la interfaz','Your language is saved on this device.':'Tu idioma se guarda en este dispositivo.','Apply Language':'Aplicar idioma','Language updated':'Idioma actualizado','Select a language':'Selecciona un idioma',
      'English':'Inglés','Spanish':'Español','French':'Francés','German':'Alemán','Portuguese':'Portugués','Italian':'Italiano','Turkish':'Turco','Arabic':'Árabe','Russian':'Ruso','Japanese':'Japonés','Korean':'Coreano','Chinese (Simplified)':'Chino (simplificado)','Amharic':'Amárico',
      'Password is required':'La contraseña es obligatoria','Please enter a valid hex color (e.g., #ff0000)':'Introduce un color hexadecimal válido (p. ej., #ff0000)','Custom accent color saved!':'¡Color de acento personalizado guardado!'
    },
    fr: {
      'Settings':'Paramètres','Profile':'Profil','Account':'Compte','Appearance':'Apparence','Privacy':'Confidentialité','Security':'Sécurité','Notifications':'Notifications','Language':'Langue','Sync':'Synchronisation','Experiments':'Expériences','My Bots':'Mes bots','Feedback':'Commentaires','Changelogs':'Journal des changements','Source Code':'Code source','Donate':'Faire un don',
      'Back':'Retour','Save Changes':'Enregistrer les modifications','Cancel':'Annuler','Save':'Enregistrer','Reset':'Réinitialiser','Close':'Fermer','Logout':'Se déconnecter','Search':'Rechercher','Friends':'Amis','Home':'Accueil','Wallet':'Portefeuille','Marketplace':'Marché','Servers':'Serveurs','Messages':'Messages',
      'Change Username':"Modifier le nom d'utilisateur",'Change Email':"Modifier l'e-mail",'Change Password':'Modifier le mot de passe','Display Name':'Nom affiché','Bio':'Bio','Username':"Nom d'utilisateur",'Email':'E-mail','Password':'Mot de passe',
      'Theme':'Thème','Accent Color':"Couleur d’accent",'Font':'Police','Custom Accent Color':"Couleur d’accent personnalisée",'Light':'Clair','Dark':'Sombre','System':'Système',
      'Enable Notifications':'Activer les notifications','Notification Sounds':'Sons de notification','Language settings':'Paramètres de langue','Choose the language you want to use across Nyxie.':'Choisissez la langue à utiliser dans Nyxie.','Interface Language':"Langue de l’interface",'Your language is saved on this device.':'Votre langue est enregistrée sur cet appareil.','Apply Language':'Appliquer la langue','Language updated':'Langue mise à jour','Select a language':'Sélectionnez une langue',
      'English':'Anglais','Spanish':'Espagnol','French':'Français','German':'Allemand','Portuguese':'Portugais','Italian':'Italien','Turkish':'Turc','Arabic':'Arabe','Russian':'Russe','Japanese':'Japonais','Korean':'Coréen','Chinese (Simplified)':'Chinois (simplifié)','Amharic':'Amharique'
    },
    de: {
      'Settings':'Einstellungen','Profile':'Profil','Account':'Konto','Appearance':'Darstellung','Privacy':'Datenschutz','Security':'Sicherheit','Notifications':'Benachrichtigungen','Language':'Sprache','Sync':'Synchronisierung','Experiments':'Experimente','My Bots':'Meine Bots','Feedback':'Feedback','Changelogs':'Änderungsprotokoll','Source Code':'Quellcode','Donate':'Spenden',
      'Back':'Zurück','Save Changes':'Änderungen speichern','Cancel':'Abbrechen','Save':'Speichern','Reset':'Zurücksetzen','Close':'Schließen','Logout':'Abmelden','Search':'Suchen','Friends':'Freunde','Home':'Startseite','Wallet':'Wallet','Marketplace':'Marktplatz','Servers':'Server','Messages':'Nachrichten',
      'Change Username':'Benutzernamen ändern','Change Email':'E-Mail ändern','Change Password':'Passwort ändern','Display Name':'Anzeigename','Bio':'Bio','Username':'Benutzername','Email':'E-Mail','Password':'Passwort',
      'Theme':'Theme','Accent Color':'Akzentfarbe','Font':'Schriftart','Custom Accent Color':'Benutzerdefinierte Akzentfarbe','Light':'Hell','Dark':'Dunkel','System':'System',
      'Enable Notifications':'Benachrichtigungen aktivieren','Notification Sounds':'Benachrichtigungstöne','Language settings':'Spracheinstellungen','Choose the language you want to use across Nyxie.':'Wähle die Sprache, die du in Nyxie verwenden möchtest.','Interface Language':'Oberflächensprache','Your language is saved on this device.':'Deine Sprache wird auf diesem Gerät gespeichert.','Apply Language':'Sprache anwenden','Language updated':'Sprache aktualisiert','Select a language':'Sprache auswählen',
      'English':'Englisch','Spanish':'Spanisch','French':'Französisch','German':'Deutsch','Portuguese':'Portugiesisch','Italian':'Italienisch','Turkish':'Türkisch','Arabic':'Arabisch','Russian':'Russisch','Japanese':'Japanisch','Korean':'Koreanisch','Chinese (Simplified)':'Chinesisch (vereinfacht)','Amharic':'Amharisch'
    },
    pt: {
      'Settings':'Configurações','Profile':'Perfil','Account':'Conta','Appearance':'Aparência','Privacy':'Privacidade','Security':'Segurança','Notifications':'Notificações','Language':'Idioma','Sync':'Sincronização','Experiments':'Experimentos','My Bots':'Meus bots','Feedback':'Feedback','Changelogs':'Alterações','Source Code':'Código-fonte','Donate':'Doar',
      'Back':'Voltar','Save Changes':'Salvar alterações','Cancel':'Cancelar','Save':'Salvar','Reset':'Redefinir','Close':'Fechar','Logout':'Sair','Search':'Pesquisar','Friends':'Amigos','Home':'Início','Wallet':'Carteira','Marketplace':'Mercado','Servers':'Servidores','Messages':'Mensagens',
      'Change Username':'Alterar nome de usuário','Change Email':'Alterar e-mail','Change Password':'Alterar senha','Display Name':'Nome de exibição','Bio':'Bio','Username':'Nome de usuário','Email':'E-mail','Password':'Senha',
      'Theme':'Tema','Accent Color':'Cor de destaque','Font':'Fonte','Custom Accent Color':'Cor de destaque personalizada','Light':'Claro','Dark':'Escuro','System':'Sistema',
      'Enable Notifications':'Ativar notificações','Notification Sounds':'Sons de notificação','Language settings':'Configurações de idioma','Choose the language you want to use across Nyxie.':'Escolha o idioma que deseja usar no Nyxie.','Interface Language':'Idioma da interface','Your language is saved on this device.':'Seu idioma é salvo neste dispositivo.','Apply Language':'Aplicar idioma','Language updated':'Idioma atualizado','Select a language':'Selecione um idioma',
      'English':'Inglês','Spanish':'Espanhol','French':'Francês','German':'Alemão','Portuguese':'Português','Italian':'Italiano','Turkish':'Turco','Arabic':'Árabe','Russian':'Russo','Japanese':'Japonês','Korean':'Coreano','Chinese (Simplified)':'Chinês (simplificado)','Amharic':'Amárico'
    },
    it: {
      'Settings':'Impostazioni','Profile':'Profilo','Account':'Account','Appearance':'Aspetto','Privacy':'Privacy','Security':'Sicurezza','Notifications':'Notifiche','Language':'Lingua','Sync':'Sincronizzazione','Experiments':'Esperimenti','My Bots':'I miei bot','Feedback':'Feedback','Changelogs':'Registro modifiche','Source Code':'Codice sorgente','Donate':'Dona',
      'Back':'Indietro','Save Changes':'Salva modifiche','Cancel':'Annulla','Save':'Salva','Reset':'Ripristina','Close':'Chiudi','Logout':'Esci','Search':'Cerca','Friends':'Amici','Home':'Home','Wallet':'Portafoglio','Marketplace':'Mercato','Servers':'Server','Messages':'Messaggi',
      'Change Username':'Cambia nome utente','Change Email':'Cambia e-mail','Change Password':'Cambia password','Display Name':'Nome visualizzato','Bio':'Bio','Username':'Nome utente','Email':'E-mail','Password':'Password',
      'Theme':'Tema','Accent Color':'Colore principale','Font':'Carattere','Custom Accent Color':'Colore principale personalizzato','Light':'Chiaro','Dark':'Scuro','System':'Sistema',
      'Enable Notifications':'Abilita notifiche','Notification Sounds':'Suoni delle notifiche','Language settings':'Impostazioni lingua','Choose the language you want to use across Nyxie.':'Scegli la lingua da usare in Nyxie.','Interface Language':'Lingua dell’interfaccia','Your language is saved on this device.':'La lingua viene salvata su questo dispositivo.','Apply Language':'Applica lingua','Language updated':'Lingua aggiornata','Select a language':'Seleziona una lingua',
      'English':'Inglese','Spanish':'Spagnolo','French':'Francese','German':'Tedesco','Portuguese':'Portoghese','Italian':'Italiano','Turkish':'Turco','Arabic':'Arabo','Russian':'Russo','Japanese':'Giapponese','Korean':'Coreano','Chinese (Simplified)':'Cinese (semplificato)','Amharic':'Amarico'
    },
    tr: {
      'Settings':'Ayarlar','Profile':'Profil','Account':'Hesap','Appearance':'Görünüm','Privacy':'Gizlilik','Security':'Güvenlik','Notifications':'Bildirimler','Language':'Dil','Sync':'Senkronizasyon','Experiments':'Deneyler','My Bots':'Botlarım','Feedback':'Geri bildirim','Changelogs':'Değişiklikler','Source Code':'Kaynak kodu','Donate':'Bağış yap',
      'Back':'Geri','Save Changes':'Değişiklikleri kaydet','Cancel':'İptal','Save':'Kaydet','Reset':'Sıfırla','Close':'Kapat','Logout':'Çıkış yap','Search':'Ara','Friends':'Arkadaşlar','Home':'Ana sayfa','Wallet':'Cüzdan','Marketplace':'Pazar yeri','Servers':'Sunucular','Messages':'Mesajlar',
      'Change Username':'Kullanıcı adını değiştir','Change Email':'E-postayı değiştir','Change Password':'Şifreyi değiştir','Display Name':'Görünen ad','Bio':'Biyografi','Username':'Kullanıcı adı','Email':'E-posta','Password':'Şifre',
      'Theme':'Tema','Accent Color':'Vurgu rengi','Font':'Yazı tipi','Custom Accent Color':'Özel vurgu rengi','Light':'Açık','Dark':'Koyu','System':'Sistem',
      'Enable Notifications':'Bildirimleri etkinleştir','Notification Sounds':'Bildirim sesleri','Language settings':'Dil ayarları','Choose the language you want to use across Nyxie.':'Nyxie genelinde kullanmak istediğiniz dili seçin.','Interface Language':'Arayüz dili','Your language is saved on this device.':'Diliniz bu cihaza kaydedilir.','Apply Language':'Dili uygula','Language updated':'Dil güncellendi','Select a language':'Bir dil seçin',
      'English':'İngilizce','Spanish':'İspanyolca','French':'Fransızca','German':'Almanca','Portuguese':'Portekizce','Italian':'İtalyanca','Turkish':'Türkçe','Arabic':'Arapça','Russian':'Rusça','Japanese':'Japonca','Korean':'Korece','Chinese (Simplified)':'Basitleştirilmiş Çince','Amharic':'Amharca'
    },
    ar: {
      'Settings':'الإعدادات','Profile':'الملف الشخصي','Account':'الحساب','Appearance':'المظهر','Privacy':'الخصوصية','Security':'الأمان','Notifications':'الإشعارات','Language':'اللغة','Sync':'المزامنة','Experiments':'التجارب','My Bots':'روبوتاتي','Feedback':'الملاحظات','Changelogs':'سجل التغييرات','Source Code':'الكود المصدري','Donate':'تبرع',
      'Back':'رجوع','Save Changes':'حفظ التغييرات','Cancel':'إلغاء','Save':'حفظ','Reset':'إعادة تعيين','Close':'إغلاق','Logout':'تسجيل الخروج','Search':'بحث','Friends':'الأصدقاء','Home':'الرئيسية','Wallet':'المحفظة','Marketplace':'السوق','Servers':'الخوادم','Messages':'الرسائل',
      'Change Username':'تغيير اسم المستخدم','Change Email':'تغيير البريد الإلكتروني','Change Password':'تغيير كلمة المرور','Display Name':'الاسم المعروض','Bio':'نبذة','Username':'اسم المستخدم','Email':'البريد الإلكتروني','Password':'كلمة المرور',
      'Theme':'السمة','Accent Color':'لون التمييز','Font':'الخط','Custom Accent Color':'لون تمييز مخصص','Light':'فاتح','Dark':'داكن','System':'النظام',
      'Enable Notifications':'تفعيل الإشعارات','Notification Sounds':'أصوات الإشعارات','Language settings':'إعدادات اللغة','Choose the language you want to use across Nyxie.':'اختر اللغة التي تريد استخدامها في Nyxie.','Interface Language':'لغة الواجهة','Your language is saved on this device.':'يتم حفظ لغتك على هذا الجهاز.','Apply Language':'تطبيق اللغة','Language updated':'تم تحديث اللغة','Select a language':'اختر لغة',
      'English':'الإنجليزية','Spanish':'الإسبانية','French':'الفرنسية','German':'الألمانية','Portuguese':'البرتغالية','Italian':'الإيطالية','Turkish':'التركية','Arabic':'العربية','Russian':'الروسية','Japanese':'اليابانية','Korean':'الكورية','Chinese (Simplified)':'الصينية المبسطة','Amharic':'الأمهرية'
    },
    ru: {
      'Settings':'Настройки','Profile':'Профиль','Account':'Аккаунт','Appearance':'Внешний вид','Privacy':'Конфиденциальность','Security':'Безопасность','Notifications':'Уведомления','Language':'Язык','Sync':'Синхронизация','Experiments':'Эксперименты','My Bots':'Мои боты','Feedback':'Обратная связь','Changelogs':'Изменения','Source Code':'Исходный код','Donate':'Поддержать',
      'Back':'Назад','Save Changes':'Сохранить изменения','Cancel':'Отмена','Save':'Сохранить','Reset':'Сбросить','Close':'Закрыть','Logout':'Выйти','Search':'Поиск','Friends':'Друзья','Home':'Главная','Wallet':'Кошелёк','Marketplace':'Маркет','Servers':'Серверы','Messages':'Сообщения',
      'Change Username':'Изменить имя пользователя','Change Email':'Изменить почту','Change Password':'Изменить пароль','Display Name':'Отображаемое имя','Bio':'О себе','Username':'Имя пользователя','Email':'Эл. почта','Password':'Пароль',
      'Theme':'Тема','Accent Color':'Акцентный цвет','Font':'Шрифт','Custom Accent Color':'Пользовательский акцентный цвет','Light':'Светлая','Dark':'Тёмная','System':'Системная',
      'Enable Notifications':'Включить уведомления','Notification Sounds':'Звуки уведомлений','Language settings':'Настройки языка','Choose the language you want to use across Nyxie.':'Выберите язык для Nyxie.','Interface Language':'Язык интерфейса','Your language is saved on this device.':'Ваш язык сохраняется на этом устройстве.','Apply Language':'Применить язык','Language updated':'Язык обновлён','Select a language':'Выберите язык',
      'English':'Английский','Spanish':'Испанский','French':'Французский','German':'Немецкий','Portuguese':'Португальский','Italian':'Итальянский','Turkish':'Турецкий','Arabic':'Арабский','Russian':'Русский','Japanese':'Японский','Korean':'Корейский','Chinese (Simplified)':'Китайский (упрощённый)','Amharic':'Амхарский'
    },
    ja: {
      'Settings':'設定','Profile':'プロフィール','Account':'アカウント','Appearance':'外観','Privacy':'プライバシー','Security':'セキュリティ','Notifications':'通知','Language':'言語','Sync':'同期','Experiments':'実験','My Bots':'マイボット','Feedback':'フィードバック','Changelogs':'変更履歴','Source Code':'ソースコード','Donate':'寄付',
      'Back':'戻る','Save Changes':'変更を保存','Cancel':'キャンセル','Save':'保存','Reset':'リセット','Close':'閉じる','Logout':'ログアウト','Search':'検索','Friends':'フレンド','Home':'ホーム','Wallet':'ウォレット','Marketplace':'マーケット','Servers':'サーバー','Messages':'メッセージ',
      'Change Username':'ユーザー名を変更','Change Email':'メールアドレスを変更','Change Password':'パスワードを変更','Display Name':'表示名','Bio':'自己紹介','Username':'ユーザー名','Email':'メール','Password':'パスワード',
      'Theme':'テーマ','Accent Color':'アクセントカラー','Font':'フォント','Custom Accent Color':'カスタムアクセントカラー','Light':'ライト','Dark':'ダーク','System':'システム',
      'Enable Notifications':'通知を有効にする','Notification Sounds':'通知音','Language settings':'言語設定','Choose the language you want to use across Nyxie.':'Nyxieで使用する言語を選択してください。','Interface Language':'インターフェース言語','Your language is saved on this device.':'言語設定はこのデバイスに保存されます。','Apply Language':'言語を適用','Language updated':'言語を更新しました','Select a language':'言語を選択',
      'English':'英語','Spanish':'スペイン語','French':'フランス語','German':'ドイツ語','Portuguese':'ポルトガル語','Italian':'イタリア語','Turkish':'トルコ語','Arabic':'アラビア語','Russian':'ロシア語','Japanese':'日本語','Korean':'韓国語','Chinese (Simplified)':'簡体字中国語','Amharic':'アムハラ語'
    },
    ko: {
      'Settings':'설정','Profile':'프로필','Account':'계정','Appearance':'모양','Privacy':'개인정보 보호','Security':'보안','Notifications':'알림','Language':'언어','Sync':'동기화','Experiments':'실험','My Bots':'내 봇','Feedback':'피드백','Changelogs':'변경 기록','Source Code':'소스 코드','Donate':'후원',
      'Back':'뒤로','Save Changes':'변경 사항 저장','Cancel':'취소','Save':'저장','Reset':'초기화','Close':'닫기','Logout':'로그아웃','Search':'검색','Friends':'친구','Home':'홈','Wallet':'지갑','Marketplace':'마켓','Servers':'서버','Messages':'메시지',
      'Change Username':'사용자 이름 변경','Change Email':'이메일 변경','Change Password':'비밀번호 변경','Display Name':'표시 이름','Bio':'소개','Username':'사용자 이름','Email':'이메일','Password':'비밀번호',
      'Theme':'테마','Accent Color':'강조 색상','Font':'글꼴','Custom Accent Color':'사용자 지정 강조 색상','Light':'밝게','Dark':'어둡게','System':'시스템',
      'Enable Notifications':'알림 활성화','Notification Sounds':'알림 소리','Language settings':'언어 설정','Choose the language you want to use across Nyxie.':'Nyxie에서 사용할 언어를 선택하세요.','Interface Language':'인터페이스 언어','Your language is saved on this device.':'언어 설정은 이 기기에 저장됩니다.','Apply Language':'언어 적용','Language updated':'언어가 업데이트되었습니다','Select a language':'언어 선택',
      'English':'영어','Spanish':'스페인어','French':'프랑스어','German':'독일어','Portuguese':'포르투갈어','Italian':'이탈리아어','Turkish':'터키어','Arabic':'아랍어','Russian':'러시아어','Japanese':'일본어','Korean':'한국어','Chinese (Simplified)':'중국어(간체)','Amharic':'암하라어'
    },
    zh: {
      'Settings':'设置','Profile':'个人资料','Account':'账户','Appearance':'外观','Privacy':'隐私','Security':'安全','Notifications':'通知','Language':'语言','Sync':'同步','Experiments':'实验','My Bots':'我的机器人','Feedback':'反馈','Changelogs':'更新日志','Source Code':'源代码','Donate':'捐赠',
      'Back':'返回','Save Changes':'保存更改','Cancel':'取消','Save':'保存','Reset':'重置','Close':'关闭','Logout':'退出登录','Search':'搜索','Friends':'好友','Home':'主页','Wallet':'钱包','Marketplace':'市场','Servers':'服务器','Messages':'消息',
      'Change Username':'修改用户名','Change Email':'修改邮箱','Change Password':'修改密码','Display Name':'显示名称','Bio':'简介','Username':'用户名','Email':'邮箱','Password':'密码',
      'Theme':'主题','Accent Color':'强调色','Font':'字体','Custom Accent Color':'自定义强调色','Light':'浅色','Dark':'深色','System':'系统',
      'Enable Notifications':'启用通知','Notification Sounds':'通知声音','Language settings':'语言设置','Choose the language you want to use across Nyxie.':'选择你想在 Nyxie 中使用的语言。','Interface Language':'界面语言','Your language is saved on this device.':'语言设置会保存在此设备上。','Apply Language':'应用语言','Language updated':'语言已更新','Select a language':'选择语言',
      'English':'英语','Spanish':'西班牙语','French':'法语','German':'德语','Portuguese':'葡萄牙语','Italian':'意大利语','Turkish':'土耳其语','Arabic':'阿拉伯语','Russian':'俄语','Japanese':'日语','Korean':'韩语','Chinese (Simplified)':'简体中文','Amharic':'阿姆哈拉语'
    },
    am: {
      'Settings':'ቅንብሮች','Profile':'መገለጫ','Account':'መለያ','Appearance':'ገጽታ','Privacy':'ግላዊነት','Security':'ደህንነት','Notifications':'ማሳወቂያዎች','Language':'ቋንቋ','Sync':'ማመሳሰል','Experiments':'ሙከራዎች','My Bots':'የእኔ ቦቶች','Feedback':'አስተያየት','Changelogs':'የለውጥ መዝገብ','Source Code':'የምንጭ ኮድ','Donate':'ይለግሱ',
      'Back':'ተመለስ','Save Changes':'ለውጦችን አስቀምጥ','Cancel':'ሰርዝ','Save':'አስቀምጥ','Reset':'ዳግም አስጀምር','Close':'ዝጋ','Logout':'ውጣ','Search':'ፈልግ','Friends':'ጓደኞች','Home':'መነሻ','Wallet':'የኪስ ቦርሳ','Marketplace':'ገበያ','Servers':'ሰርቨሮች','Messages':'መልዕክቶች',
      'Change Username':'የተጠቃሚ ስም ቀይር','Change Email':'ኢሜይል ቀይር','Change Password':'የይለፍ ቃል ቀይር','Display Name':'የሚታይ ስም','Bio':'ስለ እኔ','Username':'የተጠቃሚ ስም','Email':'ኢሜይል','Password':'የይለፍ ቃል',
      'Theme':'ገጽታ','Accent Color':'የማድመቂያ ቀለም','Font':'ፊደል','Custom Accent Color':'ብጁ የማድመቂያ ቀለም','Light':'ብርሃን','Dark':'ጨለማ','System':'ስርዓት',
      'Enable Notifications':'ማሳወቂያዎችን አንቃ','Notification Sounds':'የማሳወቂያ ድምፆች','Language settings':'የቋንቋ ቅንብሮች','Choose the language you want to use across Nyxie.':'በNyxie ላይ መጠቀም የሚፈልጉትን ቋንቋ ይምረጡ።','Interface Language':'የበይነገጽ ቋንቋ','Your language is saved on this device.':'ቋንቋዎ በዚህ መሣሪያ ላይ ይቀመጣል።','Apply Language':'ቋንቋን ተግብር','Language updated':'ቋንቋ ተዘምኗል','Select a language':'ቋንቋ ይምረጡ',
      'English':'እንግሊዝኛ','Spanish':'ስፓኒሽ','French':'ፈረንሳይኛ','German':'ጀርመንኛ','Portuguese':'ፖርቱጋልኛ','Italian':'ጣሊያንኛ','Turkish':'ቱርክኛ','Arabic':'አረብኛ','Russian':'ሩስኛ','Japanese':'ጃፓንኛ','Korean':'ኮሪያኛ','Chinese (Simplified)':'ቀላል ቻይንኛ','Amharic':'አማርኛ'
    }
  };

  // Reuse a small, safe fallback for languages whose untranslated entries
  // should remain in English rather than displaying a blank string.
  const normalize = s => (s || '').replace(/\s+/g, ' ').trim();
  function current() {
    const saved = localStorage.getItem(LANG_KEY);
    return LANGUAGES.some(l => l.code === saved) ? saved : 'en';
  }
  function languageInfo(code) {
    return LANGUAGES.find(l => l.code === code) || LANGUAGES[0];
  }
  function t(source, vars) {
    const code = current();
    let value = code === 'en' ? source : ((D[code] && D[code][source]) || source);
    if (vars) Object.keys(vars).forEach(k => { value = value.replaceAll('{' + k + '}', vars[k]); });
    return value;
  }

  let applying = false;
  function apply(root) {
    if (applying) return;
    root = root || document.body;
    applying = true;
    try {
      const code = current();
      const dict = D[code] || {};
      document.documentElement.lang = code;
      document.documentElement.dir = languageInfo(code).dir;

      root.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        el.textContent = t(key);
      });
      root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
      });
      root.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
      });

      // Translate existing static labels without requiring every old
      // template to be edited. Only exact text nodes are considered.
      if (code !== 'en') {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(node => {
          if (!node.parentElement || node.parentElement.closest('[data-i18n]')) return;
          const key = normalize(node.nodeValue);
          if (!key || !dict[key]) return;
          if (/^(SCRIPT|STYLE|TEXTAREA)$/i.test(node.parentElement.tagName)) return;
          node.nodeValue = node.nodeValue.replace(key, dict[key]);
        });
      }
    } finally {
      applying = false;
    }
  }

  function setLanguage(code) {
    if (!LANGUAGES.some(l => l.code === code)) return false;
    localStorage.setItem(LANG_KEY, code);
    apply(document.body);
    document.dispatchEvent(new CustomEvent('nyxie:languagechange', { detail: languageInfo(code) }));
    return true;
  }

  function init() {
    apply(document.body);
    const observer = new MutationObserver(mutations => {
      if (applying) return;
      mutations.forEach(m => m.addedNodes.forEach(node => {
        if (node.nodeType === 1) apply(node);
      }));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.NYXIE_LANGUAGES = LANGUAGES;
  window.t = t;
  window.applyLanguage = apply;
  window.setLanguage = setLanguage;
  window.getLanguage = current;
  window.getLanguageInfo = languageInfo;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
