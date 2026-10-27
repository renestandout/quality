# Security-Audit: Wiederholung nach kaputtem Prüftest

Analyse zu verify-15 in run-2 auf rankscan (2026-10-26).
Skill: `~/.claude/skills/security-audit/`, Upstream-Commit `c1c8a8c`.

## 1. Befund

- verify-15 prüfte die Stripe-Spur «älterer Snapshot überschreibt neueren in
  derselben Sekunde».
- Der Test des Verifiers brach in beiden Testmethoden ab:
  `Call to undefined method Symfony\Component\HttpFoundation\Response::status()`
  (`artifacts/out/junit.xml`, `assertions="0"`, `errors="2"`).
- `promote.py` meldete `command_exit 2`. `out/observed.json` fehlte.
- Der Verifier gab trotzdem einen gültigen `needs_validation`-Datensatz zurück.
  Blocker in `findings.json`: «errored in the verifier's own test harness …;
  the run is used up.»
- Der Parent übernahm den Datensatz. Bericht Zeile 10: «nein: Test-Harness des
  Verifiers brach ab».

## 2. Was den Abbruch erklärt

### 2.1 Direkte Ursache: der Verifier-Auftrag des Parents

`agents/verify-15/prompt.md:115` sagt dem Verifier:
«You get exactly one sandbox run; put everything you need into it.»

Der Parent leitete diesen Satz aus dem quality-README ab. Dort stand vor
Commit `c7357e8`: «Pro Agent-Root gibt es genau eine Übernahme» (heute
`security-audit/README.md:158`). Eine Ausnahme für einen kaputten Prüftest gab
es damals nicht. Der Verifier hielt die Spur deshalb für verbraucht.

Zeitlich belegt: `prompt.md` entstand am 2026-10-26 um 13:41, das Ergebnis um
13:44. Commit `c7357e8` folgte um 14:23.

### 2.2 Lücken im Skill

Der Skill verbietet den Abbruch nicht. Er verlangt die Wiederholung aber auch
nicht.

1. **Wiederholung nur bei kaputter Antwort.** `VALIDATION-AND-REPORTING.md:89`
   und `:143` erlauben einen neuen Verifier nur für ein «malformed or
   prose-wrapped» Ergebnis. verify-15 lieferte gültiges JSON. Die Regel griff
   deshalb nicht.
2. **Kein Wort zu einem Fehler im eigenen Test.** «Use bounded local evidence»
   (`SKILL.md:142-144`) nennt Harness und Test als Mittel. Was nach einem
   Fehler im Harness gilt, regelt der Abschnitt nicht.
3. **`needs_validation` setzt einen echten Blocker voraus.** `SKILL.md:42`:
   «If the decisive fact is outside source or the sandboxed fixture, report it
   as needing validation.» `SKILL.md:152`: Eine `needs_validation`-Spur ist
   eine «blocked» Hypothese. Bei verify-15 lag der Fakt innerhalb der Sandbox.
   Nur der Test war falsch. Der Skill sagt das aber nicht ausdrücklich. Ein
   Agent kann den Satz deshalb übersehen.
4. **Budget zählt nur Agenten.** «Cost budget» (`SKILL.md:119-134`) zählt
   jeden Verifier als Aufruf. Ob eine Weiterführung per Nachricht ein neuer
   Aufruf ist, sagt der Skill nicht.

### 2.3 Budget war nicht die Ursache

Die Vermutung «knappes Restbudget» stützen die Daten nicht.

- `run-metadata.json`: Budget 40, Plan 37, verbraucht 37. Drei Aufrufe waren
  frei.
- Im Profil `quick` war der einzige Kritiker schon gelaufen. Die Reserve für
  Kritiker band also nichts mehr.
- Eine Weiterführung von verify-15 per Nachricht hätte nach der eigenen
  Zählregel des Laufs (`agent_invocation_note`) keinen Aufruf gekostet.

Unsicherheit: Der Parent hat seine Abwägung nicht protokolliert. Ob er das
Budget mitbedachte, ist nicht belegt. Die Zahlen zeigen nur: Das Budget hätte
gereicht.

## 3. Stand nach Commit c7357e8

Das README regelt den Fall jetzt für den Parent (`README.md:162-168`) und im
Auftragsblock (`README.md:240-243`):

- Fehler im eigenen Prüftest verbraucht die Spur nicht.
- Der Parent wiederholt mit neuer Agent-ID, also mit neuem `prepare`.
- Weiterführung desselben Verifiers per Nachricht zählt nicht als neuer Aufruf.

Offen bleiben drei Punkte:

1. **Der Verifier-Auftrag.** Den Satz «exactly one sandbox run» schreibt der
   Parent selbst. Das README gibt ihm keinen fertigen Satz für den Verifier.
   Der Parent kann den alten Satz deshalb wieder schreiben.
2. **Keine Obergrenze.** Das README nennt keine Zahl der Wiederholungen. Ein
   Test, der mehrfach scheitert, kann das Budget leeren.
3. **Keine Herkunft fürs Budget.** Braucht die Wiederholung doch einen neuen
   Verifier, sagt das README nicht, aus welcher Reserve er kommt.

## 4. Vorgeschlagene Regel

Deutsch, für README und Auftragsblock:

> Scheitert der Zielbefehl am eigenen Prüftest (Fehler im Test, nicht im
> Zielcode), ist die Spur nicht verbraucht. Der Verifier gibt dann keinen
> Datensatz zurück, sondern einen neuen `sandbox_request` mit korrigiertem
> Test. Der Parent führt ihn mit neuer Agent-ID aus. Pro Spur ist genau eine
> Wiederholung erlaubt. Die Weiterführung per Nachricht zählt nicht als neuer
> Aufruf. Braucht die Wiederholung einen frischen Verifier, kommt er aus der
> Validierungs-Reserve. Scheitert auch die Wiederholung am Test, bleibt die
> Spur ein ungeprüfter Kandidat mit Grund `verifier_harness_failed`, nicht
> `needs_validation`.

Englisch, für einen Skill-Patch oder Upstream (nach «Use bounded local
evidence»):

> A local check that fails in the verifier's own harness (test error, wrong
> fixture, wrong assertion API) is not evidence and does not consume the lane.
> Correct the harness and run the check once more; continuing the same
> verifier does not count as a new agent invocation, and a fresh verifier for
> the retry comes from the validation reserve. Do not emit `needs_validation`
> because of a harness error: if the retry also fails in the harness, keep the
> fingerprint as an unvalidated candidate under the incomplete-run rule.

Die letzte Regel stützt sich auf `SKILL.md:134`: Ein ungeprüfter Kandidat
gehört nicht als `needs_validation` in `findings.json`.

## 5. Optionen

| Option                                      | Trade-off                                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A. Lokale Ergänzung in README/Auftragsblock | Kein Konflikt mit Upstream; greift nur bei Läufen mit diesem Auftragsblock, und der Skill bleibt bei Widerspruch vorrangig. |
| B. Lokaler Patch am Skill                   | Greift in jedem Lauf; jedes Upstream-Update überschreibt den Patch oder erzeugt einen Merge-Konflikt.                       |
| C. Rückmeldung an Upstream (Issue oder PR)  | Löst die Lücke für alle Nutzer; Ausgang und Dauer sind offen, bis dahin hilft sie lokal nicht.                              |

Empfehlung: **A jetzt, C danach.** Der Skill widerspricht der lokalen Regel
nicht, er schweigt nur. Der Auftragsblock reicht deshalb, wenn er den Satz für
den Verifier mitliefert und die Obergrenze nennt. C schliesst die Lücke dauerhaft
und macht B überflüssig.

## 6. Umsetzung

Option A ist umgesetzt in `security-audit/README.md`:

- Abschnitt «Ablauf pro Agent»: drei Grenzen (eine Wiederholung pro Spur,
  Verifier aus der Validierungs-Reserve, `verifier_harness_failed` statt
  `needs_validation`) und ein englischer Absatz für den Verifier-Auftrag.
- Auftragsblock: dieselben Grenzen und der Verweis auf diesen Absatz.

Option C (Rückmeldung an Upstream) ist offen.
