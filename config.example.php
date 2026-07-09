<?php
/**
 * noGrey – vzor konfigurácie pre send.php.
 * Skopíruj ako config.php a doplň skutočné údaje.
 * config.php je v .gitignore a nikdy sa necommituje.
 */
$SMTP_HOST   = 'mail.example.sk';    // SMTP server
$SMTP_PORT   = 587;                  // 587 = STARTTLS, 465 = SSL
$SMTP_SECURE = 'tls';                // 'tls' alebo 'ssl'
$SMTP_USER   = 'schranka@example.sk'; // login k schránke
$SMTP_PASS   = 'HESLO';              // heslo k schránke
$TO          = 'schranka@example.sk'; // kam chodia dopyty
$FROM        = 'schranka@example.sk'; // odosielateľ = login
$TURNSTILE_SECRET = '';              // Cloudflare Turnstile SECRET key ('' = captcha sa preskočí)
