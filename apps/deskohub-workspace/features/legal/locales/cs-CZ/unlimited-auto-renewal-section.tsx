import type { LegalSection } from "../../legal-document-body";
import { contactEmail } from "../operator-details";

export const unlimitedAutoRenewalSection: LegalSection = {
  heading: "16. Automatické obnovování členství Unlimited (návrh)",
  body: [
    "16.1 Tento článek je návrhem pro náhled. Dosud nenabyl účinnosti a opakované platby jsou vypnuté. Před spuštěním musí Nexi povolit opakované platby pro Poskytovatele.",
    "16.2 Automatické obnovování si může zvolit pouze Klient, který si členství Unlimited kupuje pro sebe. Členství poskytuje sjednané služby v navazujících obdobích po 30 kalendářních dnech v časovém pásmu Europe/Prague. Smlouva při zvoleném obnovování trvá na dobu neurčitou bez dalšího minimálního závazku. Bez této volby přístup skončí s koncem zaplaceného období.",
    "16.3 Konečná cena za každé 30denní období činí 3 490 Kč pro Open Space, 5 990 Kč pro Reserved Desk nebo 8 490 Kč pro Reserved Desk + workstation. K Open Space lze přidat kávu za 690 Kč za každé období. Varianty Reserved Desk mají kávu v ceně. Balíčky vstupů se kupují samostatně a hradí jednorázově.",
    "16.4 První období se hradí při objednávce. Před odesláním objednávky se Klientovi zobrazí vybraná varianta a služby, první den přístupu, částka k úhradě, datum příští platby a přesná částka za každé obnovení včetně zvolených pravidelných doplňků. Platba za obnovení připadá na začátek dalšího období v 00:00 pražského času. Například období od 1. prosince zahrnuje 1. až 30. prosince a další období začne 31. prosince.",
    "16.5 Klient povoluje budoucí platby z karty samostatným zaškrtávacím políčkem, které je ve výchozím stavu prázdné. Souhlas umožňuje Poskytovateli strhávat sjednanou částku každých 30 kalendářních dnů do zrušení obnovování. První karetní platba a případné ověření probíhají u Nexi. Poskytovatel použije pro další platby platební referenci. Potvrzení na trvalém nosiči obsahuje přijaté podmínky, udělený souhlas, částku, termíny a postup zrušení.",
    "16.6 Sedm kalendářních dnů před každou plánovanou platbou Poskytovatel pošle Klientovi e-mail s datem a částkou platby, dalším obdobím služby a přímým odkazem na správu obnovování. Jde o provozní zprávu, jejíž zasílání nezávisí na souhlasu s marketingem.",
    <>
      16.7 Klient může obnovování bezplatně zrušit v části Členství ve svém účtu
      nebo jednoznačným oznámením na{" "}
      <a
        className="text-burned-orange underline underline-offset-4"
        href={`mailto:${contactEmail}`}
      >
        {contactEmail}
      </a>
      . Zrušení musí proběhnout před další plánovanou platbou v 00:00 pražského
      času. Poskytovatel je potvrdí bez zbytečného odkladu. Po zrušení už
      Poskytovatel nezahájí žádnou další platbu za obnovení a přístup trvá do
      konce zaplaceného období.
    </>,
    "16.8 Poskytovatel před platbou zajistí kapacitu na celé další období. Pokud sjednanou službu nebo konkrétní místo Reserved Desk nemůže poskytnout, vyžádá si souhlas s vhodnou alternativou nebo obnovování ukončí bez platby za nové období. Jiná cena, změna pravidelného doplňku nebo podstatná změna služby vyžadují nový souhlas Klienta před platbou.",
    "16.9 Pokud se platba za obnovení nezdaří, Poskytovatel Klienta vyrozumí a nabídne mu novou objednávku. Neúspěšnou platbu nebude automaticky opakovat. Bez úhrady dalšího období přístup skončí s koncem zaplaceného období.",
    "16.10 Zrušení obnovování ukončí budoucí platby. Právo Spotřebitele odstoupit od smlouvy se posuzuje samostatně podle článku 9 a platných právních předpisů. Pokud se na smlouvu právo na odstoupení vztahuje, zahájení služby před uplynutím lhůty pro odstoupení vyžaduje samostatnou výslovnou žádost. Při odstoupení po zahájení služby lze požadovat poměrnou úhradu za již poskytnutou službu, jsou-li splněny zákonné podmínky.",
  ],
};
