// PROTOTYPE ONLY (#1361): small React Email parts shared by the two pass
// email prototypes. Built on the app's existing email components.
import type { ReactNode } from "react";
import { Column, Link, Row, Section, Text } from "react-email";
import { WorkspaceEmailLabel } from "@/emails/_components/workspace-email-content";

/** Navy panel with one aquamarine button, like the reservation emails. */
export function PassEmailAction({
  button,
  url,
  children,
}: {
  readonly button: string;
  readonly url: string;
  readonly children?: ReactNode;
}) {
  return (
    <Section className="mt-6 overflow-hidden rounded-[22px] border border-[#d8d9e4]">
      {children}
      <Section
        bgcolor="#00024f"
        className="bg-navy px-4 py-6 text-center sm:px-6"
        style={{ backgroundColor: "#00024f" }}
      >
        <Link
          className="inline-block rounded-full bg-aquamarine px-7 py-3 text-[14px] font-bold leading-[20px] text-navy no-underline"
          href={url}
          style={{ backgroundColor: "#00df99", color: "#00024f" }}
        >
          {button}
        </Link>
      </Section>
    </Section>
  );
}

/** The pass at a glance: product label, big headline, one supporting line. */
export function PassEmailHero({
  label,
  headline,
  line,
}: {
  readonly label: string;
  readonly headline: string;
  readonly line: string;
}) {
  return (
    <Section className="border-b-4 border-aquamarine bg-[#e9fff6] px-5 py-6 text-center">
      <WorkspaceEmailLabel>{label}</WorkspaceEmailLabel>
      <Text className="m-0 mt-2 text-[30px] font-bold leading-[36px] text-navy">
        {headline}
      </Text>
      <Text className="m-0 mt-1 text-[15px] leading-[22px] text-[#373a59]">
        {line}
      </Text>
    </Section>
  );
}

/** Amount lines with a bold total row. */
export function PassEmailPriceTable({
  lines,
  total,
}: {
  readonly lines: readonly { label: string; amount: string; muted?: boolean }[];
  readonly total: { label: string; amount: string };
}) {
  return (
    <Section className="mt-6 overflow-hidden rounded-2xl border border-[#e6e9f3]">
      {lines.map((line) => (
        <Row key={line.label} style={{ borderBottom: "1px solid #e6e9f3" }}>
          <Column className="px-4 py-3 align-top">
            <Text
              className="m-0 text-[14px] leading-[20px]"
              style={{ color: line.muted ? "#565975" : "#00024f" }}
            >
              {line.label}
            </Text>
          </Column>
          <Column className="w-[120px] px-4 py-3 text-right align-top">
            <Text
              className="m-0 whitespace-nowrap text-[14px] leading-[20px]"
              style={{ color: line.muted ? "#565975" : "#00024f" }}
            >
              {line.amount}
            </Text>
          </Column>
        </Row>
      ))}
      <Row style={{ backgroundColor: "#f4f1ea" }}>
        <Column className="px-4 py-3">
          <Text className="m-0 text-[15px] font-bold leading-[22px] text-navy">
            {total.label}
          </Text>
        </Column>
        <Column className="w-[120px] px-4 py-3 text-right">
          <Text className="m-0 whitespace-nowrap text-[15px] font-bold leading-[22px] text-navy">
            {total.amount}
          </Text>
        </Column>
      </Row>
    </Section>
  );
}

/** A cream box with a green label and body text. */
export function PassEmailCallout({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <Section className="mt-6 rounded-2xl bg-cream px-5 py-4">
      <WorkspaceEmailLabel>{label}</WorkspaceEmailLabel>
      <Text className="m-0 mt-2 text-[14px] leading-[22px] text-navy">
        {children}
      </Text>
    </Section>
  );
}

/**
 * WorkspaceEmailDetails, but wrapping at spaces: the shared component uses
 * break-all below `sm`, which splits dates and emails mid-word on phones.
 */
export function PassEmailDetails({
  details,
}: {
  readonly details: readonly { label: string; value: string }[];
}) {
  return (
    <Section className="mt-6 overflow-hidden rounded-2xl border border-[#e6e9f3]">
      {details.map((detail, index) => (
        <Row
          key={detail.label}
          style={{
            borderBottom:
              index === details.length - 1 ? undefined : "1px solid #e6e9f3",
          }}
        >
          <Column className="w-[26%] py-3 pl-4 pr-2 align-top">
            <Text className="m-0 text-[13px] font-bold leading-[20px] text-[#565975]">
              {detail.label}
            </Text>
          </Column>
          <Column className="py-3 pl-2 pr-4 align-top">
            <Text
              className="m-0 text-[14px] leading-[20px] text-navy"
              style={{ overflowWrap: "anywhere", wordBreak: "normal" }}
            >
              {detail.value}
            </Text>
          </Column>
        </Row>
      ))}
    </Section>
  );
}
