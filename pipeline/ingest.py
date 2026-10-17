"""Reads every lead export, normalises each row to one contact, and merges contacts per website domain.
Usage: python -P pipeline/ingest.py <out.json> <file> [<file> ...]
Formats are recognised by their headers: D&B Hoovers SearchExport, Kazi / LinkedIn lists,
Wer-zu-Wem Branchenliste and the job-index exports (advertsdata). Rows without a usable domain
(no URL and only a free-mail address) are kept in a separate list.
"""
import csv, json, os, re, sys
from collections import defaultdict

import openpyxl

FREE_MAIL = {
    "gmail.com", "googlemail.com", "hotmail.com", "hotmail.ch", "outlook.com", "live.com", "yahoo.com", "yahoo.de",
    "bluewin.ch", "gmx.ch", "gmx.de", "gmx.net", "web.de", "icloud.com", "me.com", "sunrise.ch", "hispeed.ch",
    "protonmail.com", "proton.me", "t-online.de", "aol.com", "msn.com", "swissonline.ch", "freesurf.ch", "vtxmail.ch",
}
NOT_A_SITE = re.compile(r"(linkedin|facebook|instagram|xing|twitter|x|youtube|google|wer-zu-wem|advertsdata)\.", re.I)
SENIORITY = [
    (re.compile(r"\b(owner|inhaber|founder|gründer|fondateur|propriétaire|eigentümer)", re.I), 100),
    (re.compile(r"\b(ceo|chief executive|geschäftsführ|managing director|directeur général|general manager|president|präsident|gf\b)", re.I), 95),
    (re.compile(r"\b(partner|verwaltungsrat|board|vr-)", re.I), 85),
    (re.compile(r"\b(cmo|marketing|digital|growth|brand|communication|kommunikation)", re.I), 90),
    (re.compile(r"\b(coo|cto|cfo|chief|director|direktor|leiter|head)", re.I), 75),
    (re.compile(r"\b(manager)", re.I), 55),
]


def clean(v):
    if v is None:
        return ""
    v = str(v).strip()
    return "" if v in ("#ERROR!", "None", "nan") else v


def domain_of(url):
    url = clean(url)
    m = re.search(r'HYPERLINK\("([^"]+)"', url)
    if m:
        url = m.group(1)
    if not url or " " in url.strip():
        return ""
    url = re.sub(r"^[a-z]+://", "", url.lower()).split("/")[0].split("?")[0].split("#")[0].split(":")[0]
    url = re.sub(r"^www\d?\.", "", url).strip(".")
    if "." not in url or NOT_A_SITE.search(url + "."):
        return ""
    return url


def mail_domain(email):
    email = clean(email).lower()
    if "@" not in email:
        return ""
    d = email.split("@")[1].strip(" .>")
    return "" if d in FREE_MAIL else re.sub(r"^www\.", "", d)


def seniority(title):
    for rx, s in SENIORITY:
        if rx.search(title or ""):
            return s
    return 40 if title else 20


def num(v):
    v = clean(v).replace("’", "").replace("'", "").replace(",", "")
    try:
        return float(v)
    except ValueError:
        return None


def read_csv(path):
    raw = open(path, "rb").read()
    text = raw.decode("utf-8-sig", errors="replace")
    delim = ";" if text.split("\n", 1)[0].count(";") > text.split("\n", 1)[0].count(",") else ","
    rows = list(csv.reader(text.splitlines(), delimiter=delim))
    return rows[0], rows[1:]


def read_xlsx(path):
    wb = openpyxl.load_workbook(path, read_only=True)
    for ws in wb.worksheets:
        rows = [list(r) for r in ws.iter_rows(values_only=True)]
        if rows and rows[0] and re.match(r"^FIRM\d+$", clean(rows[0][0])):
            # Headerless job-index sheet (data starts in row 1): the 12-column layout without Leadquelle/Import.
            yield ws.title, JOBINDEX_12, rows
        elif rows and rows[0] and sum(1 for c in rows[0] if c) >= 4:
            yield ws.title, [clean(c) for c in rows[0]], rows[1:]

JOBINDEX_12 = ["Index Unternehmens ID", "Lead", "URL", "Branche", "Index Stellenname", "Phone", "Contact", "E-Mail", "Kanton",
               "MA Anzahl", "Anzeigenlink", "Erscheinungstag"]


def phone_of(v):
    """Job-index exports store some numbers as plain numbers and lose the leading 0 or +: 819252627 -> 081 925 26 27."""
    s = clean(v)
    if re.fullmatch(r"\d+(\.0)?", s):
        d = s.split(".")[0]
        if len(d) == 9:
            return "0" + d
        if len(d) == 11 and d[:2] in ("41", "49", "43"):
            return "+" + d
        return d
    return s


def contact(**kw):
    c = {k: clean(v) for k, v in kw.items()}
    c["seniority"] = seniority(c.get("title", ""))
    return c


def rows_from(path):
    name = os.path.basename(path)
    sheets = read_xlsx(path) if path.lower().endswith(".xlsx") else [("csv", *read_csv(path))]
    for sheet, head, rows in sheets:
        h = {k.strip(): i for i, k in reversed(list(enumerate(head))) if k}
        g = lambda r, k: clean(r[h[k]]) if k in h and h[k] < len(r) else ""
        src = f"{name}" + (f" [{sheet}]" if sheet != "csv" else "")
        if "D-U-N-S® Number" in h:  # D&B Hoovers (full SearchExport or the trimmed sheet)
            fmt = "dnb"
        elif "GF1Vorname" in h:
            fmt = "wzw"
        elif "Index Unternehmens ID" in h or ("Index Stellenname" in h and "Lead" in h):
            fmt = "jobindex"
        elif "Company Name" in h:
            fmt = "kazi"
        else:
            print(f"skip {src}: unknown header {head[:6]}", file=sys.stderr)
            continue
        if fmt == "kazi" and len(set(head)) == 1:  # the copy whose header row got overwritten
            head = ["Company Name", "URL", "First Name", "Last Name", "Title", "Email"]
            h = {k: i for i, k in enumerate(head)}
        for r in rows:
            if not r or not any(r):
                continue
            if fmt == "dnb":
                yield dict(
                    source=src, company=g(r, "Company Name"), url=g(r, "URL"), duns=g(r, "D-U-N-S® Number"),
                    city=g(r, "City"), region=g(r, "State Or Province"), zip=g(r, "Postal Code"), country=g(r, "Country/Region"),
                    street=g(r, "Address Line 1"), phone=g(r, "Phone"), industry=g(r, "D&B Hoovers Industry"),
                    description=g(r, "Business Description"), revenue_usd=num(g(r, "Sales (USD)")),
                    employees=num(g(r, "Employees (Total)")) or num(g(r, "Employees (Single Site)")),
                    contact=contact(first=g(r, "First Name"), last=g(r, "Last Name"), title=g(r, "Title"),
                                    email=g(r, "Email"), phone=g(r, "Direct Phone"), linkedin=""),
                )
            elif fmt == "kazi":
                yield dict(
                    source=src, company=g(r, "Company Name"), url=g(r, "Website") or g(r, "URL"),
                    contact=contact(first=g(r, "First Name"), last=g(r, "Last Name"), title=g(r, "Title"),
                                    email=g(r, "EMail") or g(r, "Email"), phone="", linkedin=g(r, "Linkedin")),
                    hiring="Hiring on LinkedIn (Switzerland, 1-50 staff)",
                )
            elif fmt == "wzw":
                gfs = [(g(r, f"GF{i}Vorname"), g(r, f"GF{i}Name")) for i in range(1, 7)]
                gfs = [x for x in gfs if x[1]]
                first, last = gfs[0] if gfs else ("", "")
                yield dict(
                    source=src, company=g(r, "Firma1") or g(r, "Namen"), url=g(r, "URL"), city=g(r, "Ort"), zip=g(r, "PLZ"),
                    street=g(r, "Strasse"), country="Germany", region=g(r, "Bundesland"), phone=g(r, "Telefon"),
                    industry=" / ".join(x for x in (g(r, "Oberkategorie"), g(r, "Kategorie")) if x),
                    employees=num(g(r, "MANational")), revenue_eur_m_band=g(r, "UmsatzKlasse"),
                    contact=contact(first=first, last=last, title="Geschäftsführer" if gfs else "", email=g(r, "EMail"),
                                    phone="", linkedin=""),
                )
            else:  # jobindex
                who = g(r, "Contact").split()
                yield dict(
                    source=src, company=g(r, "Lead"), url=g(r, "URL"), industry=g(r, "Branche"), phone=phone_of(r[h["Phone"]] if "Phone" in h and h["Phone"] < len(r) else ""),
                    region=g(r, "Kanton"), country="Switzerland", employees_band=g(r, "MA Anzahl"),
                    hiring=g(r, "Index Stellenname"), job_ad=g(r, "Anzeigenlink"),
                    contact=contact(first=who[0] if who else "", last=" ".join(who[1:]), title="Geschäftsführung" if who else "",
                                    email=g(r, "E-Mail"), phone="", linkedin=""),
                )


LEGAL_WORDS = r"\b(ag|gmbh|sa|s\.a\.|sàrl|sarl|ltd|kg|co|und|holding|group|gruppe|schweiz|suisse|switzerland)\b"


def name_key(n):
    n = re.sub(LEGAL_WORDS, " ", (n or "").lower())
    return re.sub(r"[^a-z0-9äöüéèàç]+", "", n)


def merge_same_company(leads):
    """One company, two domains (its website from one file, its email domain from another): keep one lead.
    The website domain wins; the other stays in altDomains so its scan results are not lost."""
    groups = defaultdict(list)
    for L in leads.values():
        k = name_key(L["companies"][0] if L["companies"] else "")
        if len(k) >= 5:
            groups[k].append(L)
    merged = 0
    for group in groups.values():
        if len(group) < 2:
            continue
        group.sort(key=lambda L: (not L.get("siteGiven"), -len(L["sources"]), len(L["domain"])))
        keep = group[0]
        for other in group[1:]:
            keep.setdefault("altDomains", []).append(other["domain"])
            for k in ("sources", "companies", "jobAds"):
                for v in other.get(k, []):
                    if v not in keep.setdefault(k, []):
                        keep[k].append(v)
            have = {(c.get("email") or f"{c.get('first')} {c.get('last')}").lower() for c in keep["contacts"]}
            keep["contacts"] += [c for c in other["contacts"] if (c.get("email") or f"{c.get('first')} {c.get('last')}").lower() not in have]
            for k, v in other.items():
                if k not in keep and v:
                    keep[k] = v
            del leads[other["domain"]]
            merged += 1
    print(f"merged {merged} duplicate companies listed under a second domain")
    return leads


def main():
    out, files = sys.argv[1], sys.argv[2:]
    if len(files) == 1 and files[0].endswith(".txt"):  # a list of lead files, one path per line
        files = [l.strip() for l in open(files[0], encoding="utf8") if l.strip() and not l.startswith("#")]
    leads, nodomain, stats = {}, [], defaultdict(int)
    for f in files:
        for row in rows_from(f):
            stats[row["source"]] += 1
            d = domain_of(row.get("url")) or mail_domain(row["contact"].get("email"))
            if not d:
                nodomain.append(row)
                continue
            L = leads.setdefault(d, {"domain": d, "sources": [], "contacts": [], "companies": []})
            if domain_of(row.get("url")):
                L["siteGiven"] = True  # domain came from a website column, not only from an email address
            if row["source"] not in L["sources"]:
                L["sources"].append(row["source"])
            if row.get("company") and row["company"] not in L["companies"]:
                L["companies"].append(row["company"])
            if row.get("hiring"):
                ads = L.setdefault("jobAds", [])
                if row["hiring"] not in ads:
                    ads.append(row["hiring"])
            for k in ("url", "city", "region", "zip", "country", "street", "phone", "industry", "description", "revenue_usd",
                      "employees", "employees_band", "revenue_eur_m_band", "hiring", "job_ad", "duns"):
                if row.get(k) and not L.get(k):
                    L[k] = row[k]
            c = row["contact"]
            key = (c.get("email") or f"{c.get('first')} {c.get('last')}").lower().strip()
            if key and key not in {(x.get("email") or f"{x.get('first')} {x.get('last')}").lower().strip() for x in L["contacts"]}:
                L["contacts"].append(c)
    leads = merge_same_company(leads)
    for L in leads.values():
        # Prefer a name without broken umlauts (some exports lost their encoding: "W�renlos").
        clean_names = [c for c in L["companies"] if "�" not in c]
        L["company"] = (clean_names or L["companies"] or [L["domain"]])[0]
        L["contacts"].sort(key=lambda c: (-c["seniority"], not c.get("phone"), not c.get("email")))
    tmp = out + ".tmp"  # the dashboard reads this file live: swap it in whole
    json.dump({"leads": list(leads.values()), "noDomain": nodomain, "rowsPerSource": stats},
              open(tmp, "w", encoding="utf8"), ensure_ascii=False)
    os.replace(tmp, out)
    print(f"{sum(stats.values())} rows -> {len(leads)} unique domains, {len(nodomain)} rows without a domain")
    for s, n in stats.items():
        print(f"  {n:5}  {s}")


main()
