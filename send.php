<?php
/**
 * noGrey – kontaktný formulár cez SMTP.
 * Web beží na websupporte, ale odosiela sa autentifikovane priamo cez
 * poštový server webglobe (mail.webglobe.sk:587 STARTTLS), kde je schránka
 * nogrey@nogrey.sk → mail sa doručí spoľahlivo (SPF/DKIM cez webglobe).
 * Prístupové údaje sú v config.php (mimo git-u) – po zmene hesla schránky
 * ich aktualizuj tam. Vzor: config.example.php.
 */

// ================== SMTP NASTAVENIA ==================
require __DIR__ . '/config.php'; // definuje $SMTP_HOST, $SMTP_PORT, $SMTP_SECURE, $SMTP_USER, $SMTP_PASS, $TO, $FROM, $TURNSTILE_SECRET
// ====================================================

header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  http_response_code(405);
  echo json_encode(['success' => false, 'error' => 'Method not allowed']);
  exit;
}

$raw  = file_get_contents('php://input');
$data = json_decode($raw, true);
if (!is_array($data)) { $data = $_POST; }

if (!empty($data['_honey'])) { echo json_encode(['success' => true]); exit; }

// captcha Cloudflare Turnstile (overí sa, len ak je nastavený secret)
if ($TURNSTILE_SECRET !== '') {
  $tok = $data['cf-turnstile-response'] ?? '';
  $ch = curl_init('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => http_build_query([
      'secret'   => $TURNSTILE_SECRET,
      'response' => $tok,
      'remoteip' => $_SERVER['REMOTE_ADDR'] ?? '',
    ]),
    CURLOPT_TIMEOUT => 10,
  ]);
  $vj = json_decode(curl_exec($ch), true);
  curl_close($ch);
  if (empty($vj['success'])) {
    http_response_code(403);
    echo json_encode(['success' => false, 'error' => 'Overenie captcha zlyhalo. Skúste znova.']);
    exit;
  }
}

$meno   = trim($data['Meno']    ?? '');
$email  = trim($data['Email']   ?? '');
$tel    = trim($data['Telefon'] ?? '');
$dopyt  = trim($data['Dopyt']   ?? '');
$sprava = trim($data['Sprava']  ?? '');

$email = filter_var($email, FILTER_VALIDATE_EMAIL);
$telDigits = preg_replace('/\D/', '', $tel);
if ($meno === '' || !$email || $sprava === '' || strlen($telDigits) < 9) {
  http_response_code(422);
  echo json_encode(['success' => false, 'error' => 'Vyplňte meno, platný e-mail, telefón a správu.']);
  exit;
}
$menoHdr = preg_replace('/[\r\n]+/', ' ', $meno);

$subject = 'Nový dopyt z webu noGrey';
$body =
  "Nový dopyt z kontaktného formulára na nogrey.online\n" .
  "-------------------------------------------\n\n" .
  "Meno:        $meno\n" .
  "E-mail:      $email\n" .
  "Telefón:     $tel\n" .
  "Typ dopytu:  $dopyt\n\n" .
  "Správa:\n$sprava\n";

function smtp_send($host, $port, $secure, $user, $pass, $from, $fromName, $to, $subject, $body, $replyEmail) {
  $target = ($secure === 'ssl' ? 'ssl://' : '') . $host;
  $fp = @fsockopen($target, $port, $errno, $errstr, 15);
  if (!$fp) return "spojenie zlyhalo ($errstr)";
  stream_set_timeout($fp, 15);
  $read = function () use ($fp) {
    $out = '';
    while (($line = fgets($fp, 515)) !== false) { $out .= $line; if (strlen($line) >= 4 && $line[3] === ' ') break; }
    return $out;
  };
  $put = function ($c) use ($fp) { fputs($fp, $c . "\r\n"); };

  $read();
  $put("EHLO nogrey.online"); $read();
  if ($secure === 'tls') {
    $put("STARTTLS"); $read();
    if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) return "STARTTLS zlyhalo";
    $put("EHLO nogrey.online"); $read();
  }
  $put("AUTH LOGIN"); $read();
  $put(base64_encode($user)); $read();
  $put(base64_encode($pass));
  if (strpos($read(), '235') === false) return "prihlásenie zlyhalo (skontroluj heslo k nogrey@nogrey.sk)";
  $put("MAIL FROM:<$from>"); $read();
  $put("RCPT TO:<$to>"); $read();
  $put("DATA");
  if (strpos($read(), '354') === false) return "server neprijal DATA";
  $subjEnc = '=?UTF-8?B?' . base64_encode($subject) . '?=';
  $nameEnc = '=?UTF-8?B?' . base64_encode($fromName) . '?=';
  $domain  = substr(strrchr($from, '@'), 1);
  $msgId   = '<' . uniqid('ng', true) . '@' . $domain . '>';
  $headers =
    "Date: " . date('r') . "\r\n" .
    "Message-ID: $msgId\r\n" .
    "From: $nameEnc <$from>\r\n" . "To: <$to>\r\n" . "Reply-To: <$replyEmail>\r\n" .
    "Subject: $subjEnc\r\n" . "MIME-Version: 1.0\r\n" .
    "Content-Type: text/plain; charset=UTF-8\r\n" . "Content-Transfer-Encoding: 8bit\r\n" .
    "X-Mailer: noGrey-web\r\n";
  $bodyOut = preg_replace('/^\./m', '..', $body);
  fputs($fp, $headers . "\r\n" . $bodyOut . "\r\n.\r\n");
  $ok = strpos($read(), '250') !== false;
  $put("QUIT"); fclose($fp);
  return $ok ? true : "server neprijal správu";
}

$result = smtp_send($SMTP_HOST, $SMTP_PORT, $SMTP_SECURE, $SMTP_USER, $SMTP_PASS, $FROM, 'noGrey web', $TO, $subject, $body, $email);
if ($result === true) {
  echo json_encode(['success' => true]);
} else {
  http_response_code(500);
  echo json_encode(['success' => false, 'error' => 'SMTP: ' . $result]);
}
