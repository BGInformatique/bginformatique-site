<#
.SYNOPSIS
    Diagnostic complet d'un poste Windows pour BG Informatique.

.DESCRIPTION
    Collecte localement les informations système, matérielles, de sécurité,
    de performance et de configuration réseau. Génère un rapport texte sur
    le Bureau de l'utilisateur. AUCUNE donnée n'est transmise sur Internet.

    Le script est strictement en lecture seule. Aucune modification n'est
    apportée au système.

    Optimisations : une seule session CIM (DCOM) réutilisée pour toutes les
    requêtes WMI, filtrage côté serveur (WQL) pour les classes volumineuses
    (périphériques, services) et mesure de la durée d'exécution.

.NOTES
    Auteur  : BG Informatique - https://bginformatique.ca
    Licence : Usage diagnostic. Le rapport reste la propriété du client.
    Contact : information@bginformatique.ca - 450 231-9199
#>

# ─── Préparation ─────────────────────────────────────────────────────────
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference    = 'SilentlyContinue'

$Sw         = [System.Diagnostics.Stopwatch]::StartNew()
$Stamp      = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
$Desktop    = [Environment]::GetFolderPath('Desktop')
if (-not (Test-Path $Desktop)) { $Desktop = $env:USERPROFILE }
$ReportPath = Join-Path $Desktop "Diagnostic-BG_$Stamp.txt"

$Report = New-Object System.Text.StringBuilder

function Add-Line  { param([string]$Text='') [void]$Report.AppendLine($Text) }
function Add-Header {
    param([string]$Title)
    Add-Line ''
    Add-Line ('=' * 70)
    Add-Line ("  $Title")
    Add-Line ('=' * 70)
}
function Add-Sub { param([string]$Title) Add-Line ''; Add-Line "-- $Title --" }
function Add-KV  { param([string]$K,[object]$V) Add-Line ("  {0,-28} : {1}" -f $K, $V) }
function Safe    { param([scriptblock]$Block,[string]$Fallback='(indisponible)') try { & $Block } catch { $Fallback } }

# Session CIM unique, réutilisée pour toutes les requêtes WMI.
# Protocole DCOM : fonctionne localement sans dépendre du service WinRM.
$CimSession = $null
try {
    $CimSession = New-CimSession -SessionOption (New-CimSessionOption -Protocol Dcom) -ErrorAction Stop
} catch { $CimSession = $null }

function Get-Cim {
    param(
        [Parameter(Mandatory)][string]$Class,
        [string]$Filter,
        [string]$Namespace
    )
    $p = @{ ClassName = $Class; ErrorAction = 'Stop' }
    if ($CimSession) { $p.CimSession = $CimSession }
    if ($Filter)     { $p.Filter     = $Filter }
    if ($Namespace)  { $p.Namespace  = $Namespace }
    Get-CimInstance @p
}

# ─── En-tête du rapport ──────────────────────────────────────────────────
Add-Line ('=' * 70)
Add-Line '          RAPPORT DE DIAGNOSTIC - BG INFORMATIQUE'
Add-Line '          https://bginformatique.ca'
Add-Line ('=' * 70)
Add-KV 'Date de generation' (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Add-KV 'Utilisateur'        "$env:USERDOMAIN\$env:USERNAME"
Add-KV 'Poste'              $env:COMPUTERNAME
$IsAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Add-KV 'Execution privilegiee' $(if ($IsAdmin) {'Oui (administrateur)'} else {'Non (utilisateur standard - certaines sections seront limitees)'} )

Write-Host ''
Write-Host '  Diagnostic BG Informatique - en cours...' -ForegroundColor Cyan
Write-Host '  Aucune donnee envoyee sur Internet. Rapport local seulement.' -ForegroundColor DarkGray
Write-Host ''

# ─── 1. Identite et systeme d'exploitation ───────────────────────────────
Write-Host '  [1/12] Systeme d''exploitation...'
Add-Header '1. SYSTEME D''EXPLOITATION'
$os  = Safe { Get-Cim Win32_OperatingSystem }
$cs  = Safe { Get-Cim Win32_ComputerSystem }
$bios= Safe { Get-Cim Win32_BIOS }
if ($os) {
    Add-KV 'Edition'        $os.Caption
    Add-KV 'Version'        $os.Version
    Add-KV 'Build'          $os.BuildNumber
    Add-KV 'Architecture'   $os.OSArchitecture
    Add-KV 'Langue'         $os.OSLanguage
    Add-KV 'Installe le'    (Safe { $os.InstallDate.ToString('yyyy-MM-dd HH:mm') })
    Add-KV 'Dernier boot'   (Safe { $os.LastBootUpTime.ToString('yyyy-MM-dd HH:mm') })
    $uptime = Safe { (Get-Date) - $os.LastBootUpTime }
    if ($uptime) { Add-KV 'Uptime' ("{0} jours {1:D2}h {2:D2}min" -f $uptime.Days, $uptime.Hours, $uptime.Minutes) }
}
Add-Sub 'Materiel general'
if ($cs) {
    Add-KV 'Fabricant'   $cs.Manufacturer
    Add-KV 'Modele'      $cs.Model
    Add-KV 'Type'        $cs.SystemType
    Add-KV 'Domaine/WG'  $cs.Domain
}
if ($bios) {
    Add-KV 'BIOS - fabricant' $bios.Manufacturer
    Add-KV 'BIOS - version'   $bios.SMBIOSBIOSVersion
    Add-KV 'BIOS - date'      (Safe { $bios.ReleaseDate.ToString('yyyy-MM-dd') })
    Add-KV 'Numero de serie'  $bios.SerialNumber
}

# ─── 2. Processeur et memoire ────────────────────────────────────────────
Write-Host '  [2/12] Processeur et memoire...'
Add-Header '2. PROCESSEUR ET MEMOIRE'
$cpu = Safe { Get-Cim Win32_Processor }
if ($cpu) {
    foreach ($c in @($cpu)) {
        Add-KV 'Processeur'         $c.Name
        Add-KV 'Coeurs / threads'   ("{0} / {1}" -f $c.NumberOfCores, $c.NumberOfLogicalProcessors)
        Add-KV 'Frequence (MHz)'    $c.MaxClockSpeed
        Add-KV 'Charge actuelle (%)' $c.LoadPercentage
    }
}
Add-Sub 'Memoire vive'
if ($os) {
    $totalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
    $freeGB  = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
    $usedGB  = [math]::Round($totalGB - $freeGB, 2)
    $usedPct = if ($totalGB -gt 0) { [math]::Round(($usedGB / $totalGB) * 100, 1) } else { 0 }
    Add-KV 'RAM totale (GB)'     $totalGB
    Add-KV 'RAM utilisee (GB)'   "$usedGB ($usedPct %)"
    Add-KV 'RAM libre (GB)'      $freeGB
}
Add-Sub 'Barrettes physiques'
$mem = Safe { Get-Cim Win32_PhysicalMemory }
if ($mem) {
    $i = 1
    foreach ($m in @($mem)) {
        $sizeGB = [math]::Round($m.Capacity / 1GB, 1)
        Add-KV ("Barrette $i") ("$sizeGB GB - $($m.Speed) MHz - $($m.Manufacturer) - $($m.PartNumber)")
        $i++
    }
} else { Add-Line '  (information indisponible)' }

# ─── 3. Stockage ─────────────────────────────────────────────────────────
Write-Host '  [3/12] Stockage et disques...'
Add-Header '3. STOCKAGE'
Add-Sub 'Disques physiques'
$pdisks = Safe { Get-PhysicalDisk }
if ($pdisks) {
    foreach ($d in @($pdisks)) {
        $sizeGB = [math]::Round($d.Size / 1GB, 1)
        Add-Line ('  - {0} ({1}) - {2} GB - SMART: {3} - etat: {4}' -f `
            $d.FriendlyName, $d.MediaType, $sizeGB, $d.HealthStatus, $d.OperationalStatus)
    }
} else { Add-Line '  (Get-PhysicalDisk indisponible)' }

Add-Sub 'Volumes (partitions montees)'
$vols = Safe { Get-Volume | Where-Object { $_.DriveLetter } }
if ($vols) {
    foreach ($v in @($vols)) {
        $totalGB = [math]::Round($v.Size / 1GB, 1)
        $freeGB  = [math]::Round($v.SizeRemaining / 1GB, 1)
        $usedPct = if ($v.Size -gt 0) { [math]::Round((($v.Size - $v.SizeRemaining) / $v.Size) * 100, 1) } else { 0 }
        $flag = if ($usedPct -ge 90) { ' [!] ESPACE CRITIQUE' } elseif ($usedPct -ge 80) { ' [!] espace faible' } else { '' }
        Add-Line ('  {0}: ({1}) FS={2} - total={3} GB - libre={4} GB ({5}% utilises){6}' -f `
            $v.DriveLetter, $v.FileSystemLabel, $v.FileSystem, $totalGB, $freeGB, $usedPct, $flag)
    }
}

# ─── 4. Securite ─────────────────────────────────────────────────────────
Write-Host '  [4/12] Securite (Defender, pare-feu, BitLocker)...'
Add-Header '4. SECURITE'
Add-Sub 'Windows Defender'
$mp = Safe { Get-MpComputerStatus }
if ($mp) {
    Add-KV 'Antivirus active'         $mp.AntivirusEnabled
    Add-KV 'Protection temps reel'    $mp.RealTimeProtectionEnabled
    Add-KV 'Protection navigateur'    $mp.IoavProtectionEnabled
    Add-KV 'Signatures - version'     $mp.AntivirusSignatureVersion
    Add-KV 'Signatures - age (jours)' $mp.AntivirusSignatureAge
    Add-KV 'Derniere analyse rapide'  (Safe { $mp.QuickScanEndTime.ToString('yyyy-MM-dd HH:mm') })
    Add-KV 'Derniere analyse complete'(Safe { $mp.FullScanEndTime.ToString('yyyy-MM-dd HH:mm') })
} else { Add-Line '  (Get-MpComputerStatus indisponible - peut necessiter privileges admin)' }

Add-Sub 'Antivirus / antimalware enregistres'
$av = Safe { Get-Cim -Class AntivirusProduct -Namespace 'root\SecurityCenter2' }
if ($av) {
    foreach ($a in @($av)) {
        Add-Line "  - $($a.displayName) (executable: $($a.pathToSignedReportingExe))"
    }
} else { Add-Line '  (aucun ou indisponible)' }

Add-Sub 'Pare-feu Windows'
$fw = Safe { Get-NetFirewallProfile }
if ($fw) {
    foreach ($p in @($fw)) {
        Add-KV ("Profil " + $p.Name) ("Actif=$($p.Enabled) - Bloque entrant=$($p.DefaultInboundAction)")
    }
}

Add-Sub 'BitLocker'
$bl = Safe { Get-BitLockerVolume }
if ($bl) {
    foreach ($b in @($bl)) {
        Add-KV ("Volume " + $b.MountPoint) ("Protection=$($b.ProtectionStatus) - Chiffrement=$($b.EncryptionPercentage)% - Methode=$($b.EncryptionMethod)")
    }
} else { Add-Line '  (BitLocker non disponible sur ce poste, ou commande indisponible)' }

# ─── 5. Mises a jour ─────────────────────────────────────────────────────
Write-Host '  [5/12] Historique Windows Update...'
Add-Header '5. MISES A JOUR WINDOWS'
$hf = Safe { Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 15 }
if ($hf) {
    Add-Sub '15 dernieres mises a jour installees'
    foreach ($h in @($hf)) {
        $date = if ($h.InstalledOn) { $h.InstalledOn.ToString('yyyy-MM-dd') } else { '(inconnue)' }
        Add-Line ("  $date  $($h.HotFixID)  $($h.Description)")
    }
} else { Add-Line '  (historique indisponible)' }

# ─── 6. Performance instantanee ──────────────────────────────────────────
Write-Host '  [6/12] Charge actuelle - top processus...'
Add-Header '6. PERFORMANCE - PROCESSUS LES PLUS LOURDS'
$procs = Safe { Get-Process | Where-Object { $_.WS -gt 0 } }
if ($procs) {
    Add-Sub 'Top 10 par memoire (Working Set)'
    $procs | Sort-Object WS -Descending | Select-Object -First 10 | ForEach-Object {
        $memMB = [math]::Round($_.WS / 1MB, 1)
        Add-Line ('  {0,8} MB   {1,-6}   {2}' -f $memMB, $_.Id, $_.ProcessName)
    }
    Add-Sub 'Top 10 par temps CPU cumule'
    $procs | Where-Object { $_.CPU } | Sort-Object CPU -Descending | Select-Object -First 10 | ForEach-Object {
        $cpuSec = [math]::Round($_.CPU, 1)
        Add-Line ('  {0,8} s    {1,-6}   {2}' -f $cpuSec, $_.Id, $_.ProcessName)
    }
}

# ─── 7. Demarrage automatique ────────────────────────────────────────────
Write-Host '  [7/12] Programmes au demarrage...'
Add-Header '7. PROGRAMMES AU DEMARRAGE'
$startup = Safe { Get-Cim Win32_StartupCommand }
if ($startup) {
    foreach ($s in @($startup)) {
        Add-Line ("  [$($s.Location)]  $($s.Name)")
        Add-Line ("        $($s.Command)")
    }
} else { Add-Line '  (aucun ou indisponible)' }

# ─── 8. Services ─────────────────────────────────────────────────────────
Write-Host '  [8/12] Services Windows...'
Add-Header '8. SERVICES PROBLEMATIQUES'
Add-Sub 'Services configures en automatique mais arretes'
# Filtrage cote serveur (WQL) : on ne ramene que les services en demarrage
# automatique qui ne tournent pas, au lieu de charger les ~200 services du poste.
$svc = Safe { Get-Cim -Class Win32_Service -Filter "StartMode = 'Auto' AND State <> 'Running'" | Where-Object { $_.Name -notlike 'edgeupdate*' } }
if ($svc) {
    foreach ($s in @($svc)) {
        Add-Line ("  [$($s.State)]  $($s.Name)  -  $($s.DisplayName)")
    }
} else { Add-Line '  (aucun service problematique detecte)' }

# ─── 9. Erreurs du journal d'evenements ──────────────────────────────────
Write-Host '  [9/12] Journal d''evenements (7 derniers jours)...'
Add-Header '9. ERREURS RECENTES (7 DERNIERS JOURS)'
$since = (Get-Date).AddDays(-7)

Add-Sub 'Journal SYSTEM - erreurs et critiques'
$sysErr = Safe { Get-WinEvent -FilterHashtable @{ LogName='System'; Level=1,2; StartTime=$since } -MaxEvents 20 }
if ($sysErr) {
    $sysErr | Group-Object ProviderName | Sort-Object Count -Descending | Select-Object -First 10 | ForEach-Object {
        Add-Line ("  {0,4}x  {1}" -f $_.Count, $_.Name)
    }
    Add-Line ''
    Add-Line '  5 derniers evenements detailles :'
    $sysErr | Select-Object -First 5 | ForEach-Object {
        Add-Line ("  - $($_.TimeCreated.ToString('yyyy-MM-dd HH:mm')) [$($_.LevelDisplayName)] $($_.ProviderName) (ID $($_.Id))")
        $msg = if ($_.Message) { $_.Message.Split("`n")[0].Trim() } else { '' }
        if ($msg) { Add-Line ('        ' + $msg.Substring(0, [Math]::Min(180, $msg.Length))) }
    }
} else { Add-Line '  (aucune erreur recente, ou journal inaccessible)' }

Add-Sub 'Journal APPLICATION - erreurs et critiques'
$appErr = Safe { Get-WinEvent -FilterHashtable @{ LogName='Application'; Level=1,2; StartTime=$since } -MaxEvents 20 }
if ($appErr) {
    $appErr | Group-Object ProviderName | Sort-Object Count -Descending | Select-Object -First 10 | ForEach-Object {
        Add-Line ("  {0,4}x  {1}" -f $_.Count, $_.Name)
    }
} else { Add-Line '  (aucune erreur recente, ou journal inaccessible)' }

# ─── 10. Reseau ──────────────────────────────────────────────────────────
Write-Host '  [10/12] Configuration reseau...'
Add-Header '10. CONFIGURATION RESEAU'
Add-Sub 'Cartes reseau actives'
$nics = Safe { Get-NetAdapter | Where-Object Status -eq 'Up' }
if ($nics) {
    foreach ($n in @($nics)) {
        Add-Line ("  - $($n.Name) | $($n.InterfaceDescription) | $($n.LinkSpeed) | MAC: $($n.MacAddress)")
    }
}
Add-Sub 'Adresses IPv4'
$ips = Safe { Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } }
if ($ips) {
    foreach ($ip in @($ips)) {
        Add-Line ("  - $($ip.InterfaceAlias) : $($ip.IPAddress) /$($ip.PrefixLength)")
    }
}
Add-Sub 'Passerelle et DNS'
$gw = Safe { Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object -First 1 }
if ($gw) { Add-KV 'Passerelle par defaut' $gw.NextHop }
$dns = Safe { Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.ServerAddresses } }
if ($dns) {
    foreach ($d in @($dns)) {
        Add-KV ("DNS [" + $d.InterfaceAlias + "]") ($d.ServerAddresses -join ', ')
    }
}
Add-Sub 'Test de connectivite Internet'
$ping = Safe { Test-Connection -ComputerName '8.8.8.8' -Count 2 -Quiet }
Add-KV 'Ping 8.8.8.8'    $(if ($ping) {'OK'} else {'echec'})
$dnsTest = Safe { Resolve-DnsName 'bginformatique.ca' -ErrorAction Stop | Select-Object -First 1 }
Add-KV 'Resolution DNS'  $(if ($dnsTest) {"OK ($($dnsTest.IPAddress))"} else {'echec'})

# ─── 11. Drivers et periphériques ────────────────────────────────────────
Write-Host '  [11/12] Peripheriques en erreur...'
Add-Header '11. PERIPHERIQUES EN ERREUR'
# Filtrage cote serveur (WQL) : on demande directement les peripheriques en
# erreur plutot que de charger les centaines d'entrees PnP du poste.
$badDev = Safe { Get-Cim -Class Win32_PnPEntity -Filter 'ConfigManagerErrorCode <> 0' }
if ($badDev) {
    foreach ($d in @($badDev)) {
        Add-Line ("  - [code $($d.ConfigManagerErrorCode)] $($d.Name)")
    }
} else { Add-Line '  (aucun peripherique en erreur detecte)' }

# ─── 12. Programmes installes ────────────────────────────────────────────
Write-Host '  [12/12] Inventaire des programmes installes...'
Add-Header '12. PROGRAMMES INSTALLES'
$paths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$apps = foreach ($p in $paths) {
    Safe { Get-ItemProperty $p | Where-Object { $_.DisplayName } }
}
$apps = $apps | Sort-Object DisplayName -Unique
Add-KV 'Nombre de programmes detectes' (@($apps).Count)
Add-Line ''
foreach ($a in $apps) {
    $ver = if ($a.DisplayVersion) { " v$($a.DisplayVersion)" } else { '' }
    $pub = if ($a.Publisher) { " - $($a.Publisher)" } else { '' }
    Add-Line ("  - $($a.DisplayName)$ver$pub")
}

# ─── Liberation de la session CIM ────────────────────────────────────────
if ($CimSession) { Remove-CimSession $CimSession -ErrorAction SilentlyContinue }

# ─── Cloture et sauvegarde ───────────────────────────────────────────────
$Sw.Stop()
Add-Line ''
Add-Line ('=' * 70)
Add-Line '                          FIN DU RAPPORT'
Add-Line ('=' * 70)
Add-Line ("  Diagnostic execute en {0:N1} secondes." -f $Sw.Elapsed.TotalSeconds)
Add-Line ''
Add-Line 'Ce rapport est strictement local. Aucune donnee n''a ete transmise.'
Add-Line 'Pour nous l''envoyer : information@bginformatique.ca - 450 231-9199'
Add-Line 'https://bginformatique.ca'

try {
    $Report.ToString() | Out-File -FilePath $ReportPath -Encoding UTF8
    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Green
    Write-Host '   RAPPORT GENERE AVEC SUCCES' -ForegroundColor Green
    Write-Host '  ============================================================' -ForegroundColor Green
    Write-Host ''
    Write-Host "  Fichier : $ReportPath" -ForegroundColor White
    Write-Host ("  Duree   : {0:N1} secondes" -f $Sw.Elapsed.TotalSeconds) -ForegroundColor White
    Write-Host ''
    Write-Host '  Vous pouvez maintenant :' -ForegroundColor White
    Write-Host '   1. Ouvrir le fichier pour verifier son contenu' -ForegroundColor Gray
    Write-Host '   2. Le joindre a un courriel adresse a :' -ForegroundColor Gray
    Write-Host '      information@bginformatique.ca' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  Aucune donnee n''a ete transmise sur Internet.' -ForegroundColor DarkGray
    Write-Host ''
    try { Start-Process notepad.exe -ArgumentList "`"$ReportPath`"" } catch { }
} catch {
    Write-Host ''
    Write-Host "  Erreur lors de l'ecriture du rapport : $_" -ForegroundColor Red
    Write-Host '  Le contenu va etre affiche dans la console.' -ForegroundColor Yellow
    Write-Host ''
    Write-Output $Report.ToString()
}
