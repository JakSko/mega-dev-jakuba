# Sets OWNER_CODE on the Railway service away-agent. Jakub types the code; it is never shown,
# never written to a file and never passes through the chat. Run from challenges/s02e05-away.
$a = Read-Host -AsSecureString "Wymysl kod wlasciciela (min 8 znakow)"
$b = Read-Host -AsSecureString "Wpisz go jeszcze raz"
$pa = [System.Net.NetworkCredential]::new('', $a).Password
$pb = [System.Net.NetworkCredential]::new('', $b).Password
if ($pa -ne $pb) { Write-Host "Kody sie roznia. Uruchom jeszcze raz."; exit 1 }
if ($pa.Trim().Length -lt 8) { Write-Host "Za krotki (min 8 znakow). Uruchom jeszcze raz."; exit 1 }
$pa.Trim() | railway variable set OWNER_CODE --stdin --service away-agent --skip-deploys
$pa = $null; $pb = $null
Write-Host "Gotowe. Zapisz ten kod w menedzerze hasel - wpiszesz go na telefonie przy zatwierdzaniu."
