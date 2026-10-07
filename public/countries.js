/* ============================================================
   Country calling codes + helpers for phone numbers.
   Phone numbers are saved in international form: "+" and digits only, e.g. +4512345678
   ============================================================ */
(function () {
  'use strict';

  // ISO code | name | calling code (shared "+1" countries list their area code, e.g. Bahamas = 1242)
  const RAW = `AF|Afghanistan|93;AL|Albania|355;DZ|Algeria|213;AS|American Samoa|1684;AD|Andorra|376;AO|Angola|244;AI|Anguilla|1264;
AG|Antigua and Barbuda|1268;AR|Argentina|54;AM|Armenia|374;AW|Aruba|297;AU|Australia|61;AT|Austria|43;AZ|Azerbaijan|994;BS|Bahamas|1242;
BH|Bahrain|973;BD|Bangladesh|880;BB|Barbados|1246;BY|Belarus|375;BE|Belgium|32;BZ|Belize|501;BJ|Benin|229;BM|Bermuda|1441;BT|Bhutan|975;
BO|Bolivia|591;BA|Bosnia and Herzegovina|387;BW|Botswana|267;BR|Brazil|55;IO|British Indian Ocean Territory|246;VG|British Virgin Islands|1284;
BN|Brunei|673;BG|Bulgaria|359;BF|Burkina Faso|226;BI|Burundi|257;KH|Cambodia|855;CM|Cameroon|237;CA|Canada|1;CV|Cape Verde|238;
KY|Cayman Islands|1345;CF|Central African Republic|236;TD|Chad|235;CL|Chile|56;CN|China|86;CO|Colombia|57;KM|Comoros|269;
CG|Congo|242;CD|Congo (DR)|243;CK|Cook Islands|682;CR|Costa Rica|506;CI|Côte d’Ivoire|225;HR|Croatia|385;CU|Cuba|53;CW|Curaçao|599;
CY|Cyprus|357;CZ|Czechia|420;DK|Denmark|45;DJ|Djibouti|253;DM|Dominica|1767;DO|Dominican Republic|1;EC|Ecuador|593;EG|Egypt|20;
SV|El Salvador|503;GQ|Equatorial Guinea|240;ER|Eritrea|291;EE|Estonia|372;SZ|Eswatini|268;ET|Ethiopia|251;FK|Falkland Islands|500;
FO|Faroe Islands|298;FJ|Fiji|679;FI|Finland|358;FR|France|33;GF|French Guiana|594;PF|French Polynesia|689;GA|Gabon|241;GM|Gambia|220;
GE|Georgia|995;DE|Germany|49;GH|Ghana|233;GI|Gibraltar|350;GR|Greece|30;GL|Greenland|299;GD|Grenada|1473;GP|Guadeloupe|590;GU|Guam|1671;
GT|Guatemala|502;GN|Guinea|224;GW|Guinea-Bissau|245;GY|Guyana|592;HT|Haiti|509;HN|Honduras|504;HK|Hong Kong|852;HU|Hungary|36;
IS|Iceland|354;IN|India|91;ID|Indonesia|62;IR|Iran|98;IQ|Iraq|964;IE|Ireland|353;IL|Israel|972;IT|Italy|39;JM|Jamaica|1876;JP|Japan|81;
JO|Jordan|962;KZ|Kazakhstan|7;KE|Kenya|254;KI|Kiribati|686;XK|Kosovo|383;KW|Kuwait|965;KG|Kyrgyzstan|996;LA|Laos|856;LV|Latvia|371;
LB|Lebanon|961;LS|Lesotho|266;LR|Liberia|231;LY|Libya|218;LI|Liechtenstein|423;LT|Lithuania|370;LU|Luxembourg|352;MO|Macao|853;
MG|Madagascar|261;MW|Malawi|265;MY|Malaysia|60;MV|Maldives|960;ML|Mali|223;MT|Malta|356;MH|Marshall Islands|692;MQ|Martinique|596;
MR|Mauritania|222;MU|Mauritius|230;MX|Mexico|52;FM|Micronesia|691;MD|Moldova|373;MC|Monaco|377;MN|Mongolia|976;ME|Montenegro|382;
MS|Montserrat|1664;MA|Morocco|212;MZ|Mozambique|258;MM|Myanmar|95;NA|Namibia|264;NR|Nauru|674;NP|Nepal|977;NL|Netherlands|31;
NC|New Caledonia|687;NZ|New Zealand|64;NI|Nicaragua|505;NE|Niger|227;NG|Nigeria|234;KP|North Korea|850;MK|North Macedonia|389;
MP|Northern Mariana Islands|1670;NO|Norway|47;OM|Oman|968;PK|Pakistan|92;PW|Palau|680;PS|Palestine|970;PA|Panama|507;
PG|Papua New Guinea|675;PY|Paraguay|595;PE|Peru|51;PH|Philippines|63;PL|Poland|48;PT|Portugal|351;PR|Puerto Rico|1;QA|Qatar|974;
RE|Réunion|262;RO|Romania|40;RU|Russia|7;RW|Rwanda|250;WS|Samoa|685;SM|San Marino|378;ST|São Tomé and Príncipe|239;SA|Saudi Arabia|966;
SN|Senegal|221;RS|Serbia|381;SC|Seychelles|248;SL|Sierra Leone|232;SG|Singapore|65;SX|Sint Maarten|1721;SK|Slovakia|421;SI|Slovenia|386;
SB|Solomon Islands|677;SO|Somalia|252;ZA|South Africa|27;KR|South Korea|82;SS|South Sudan|211;ES|Spain|34;LK|Sri Lanka|94;
KN|St Kitts and Nevis|1869;LC|St Lucia|1758;VC|St Vincent and the Grenadines|1784;SD|Sudan|249;SR|Suriname|597;SE|Sweden|46;
CH|Switzerland|41;SY|Syria|963;TW|Taiwan|886;TJ|Tajikistan|992;TZ|Tanzania|255;TH|Thailand|66;TL|Timor-Leste|670;TG|Togo|228;
TO|Tonga|676;TT|Trinidad and Tobago|1868;TN|Tunisia|216;TR|Türkiye|90;TM|Turkmenistan|993;TC|Turks and Caicos Islands|1649;TV|Tuvalu|688;
UG|Uganda|256;UA|Ukraine|380;AE|United Arab Emirates|971;GB|United Kingdom|44;US|United States|1;UY|Uruguay|598;VI|US Virgin Islands|1340;
UZ|Uzbekistan|998;VU|Vanuatu|678;VE|Venezuela|58;VN|Vietnam|84;YE|Yemen|967;ZM|Zambia|260;ZW|Zimbabwe|263`;

  const list = RAW.replace(/\n/g, '').split(';').filter(Boolean).map(s => {
    const [iso, name, dial] = s.trim().split('|');
    return { iso, name, dial, keepZero: iso === 'IT' };   // Italian numbers keep their leading 0 internationally
  }).sort((a, b) => a.name.localeCompare(b.name));

  const byIso = Object.fromEntries(list.map(c => [c.iso, c]));
  // when a calling code is shared (+1, +7, +44 ...) this country is the one that is selected automatically
  const PREFERRED = { 1: 'US', 7: 'RU', 39: 'IT', 44: 'GB', 262: 'RE', 590: 'GP', 599: 'CW' };
  const dials = [...new Set(list.map(c => c.dial))].sort((a, b) => b.length - a.length);   // longest first
  const isoForDial = d => PREFERRED[d] || list.find(c => c.dial === d).iso;

  const flag = iso => String.fromCodePoint(...[...iso].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65));

  // the country this person is probably in, from the browser language (en-DK -> Denmark)
  function guess() {
    try {
      const saved = localStorage.getItem('ping_cc');
      if (saved && byIso[saved]) return saved;
    } catch { /* private mode */ }
    for (const l of (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''])) {
      const m = /[-_]([A-Za-z]{2})\b/.exec(l);
      if (m && byIso[m[1].toUpperCase()]) return m[1].toUpperCase();
    }
    return 'US';
  }

  // "+4512..." or "004512..." -> which country does it start with?
  function matchDial(digits) {
    const d = dials.find(x => digits.startsWith(x));
    return d ? { dial: d, iso: isoForDial(d), national: digits.slice(d.length) } : null;
  }

  // Turn what the person typed into +E164. Returns { ok, e164 } or { ok:false, error }.
  function toE164(raw, iso) {
    const s = String(raw || '').trim();
    let digits = s.replace(/\D/g, '');
    if (s.startsWith('00')) digits = digits.slice(2);
    else if (!s.startsWith('+')) {
      const c = byIso[iso];
      if (!c) return { ok: false, error: 'Choose your country' };
      let national = digits;
      if (!c.keepZero) national = national.replace(/^0/, '');   // 012 345 678 -> 12 345 678
      digits = c.dial + national;
    }
    if (!/^[1-9]\d*$/.test(digits)) return { ok: false, error: 'Enter your phone number' };
    if (digits.length < 8) return { ok: false, error: 'This number looks too short' };
    if (digits.length > 15) return { ok: false, error: 'This number is too long' };
    return { ok: true, e164: '+' + digits };
  }

  // +4512345678 -> "+45 12345678"   (+1242... -> "+1 242 5551234")
  function pretty(id) {
    const s = String(id || '');
    if (!/^\+\d{8,15}$/.test(s)) return s;
    const m = matchDial(s.slice(1));
    if (!m) return s;
    const head = m.dial.length > 1 && m.dial[0] === '1' && m.dial.length === 4 ? '1 ' + m.dial.slice(1) : m.dial;
    return '+' + head + ' ' + m.national;
  }

  window.PingCountries = { list, byIso, flag, guess, matchDial, toE164, pretty };
})();
