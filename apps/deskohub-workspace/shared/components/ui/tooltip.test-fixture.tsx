import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FutureFeatureTooltip } from "@/features/account/components/future-feature-tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Toggle } from "./toggle";
import { Tooltip } from "./tooltip";

function Fixture() {
  const [submissions, setSubmissions] = useState(0);

  return (
    <>
      <button type="button">Before</button>
      <div style={{ margin: "100px 0 0 150px" }}>
        <Tooltip trigger={<Toggle aria-label="Format">Format</Toggle>}>
          Formatting hint
        </Tooltip>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSubmissions((count) => count + 1);
          }}
        >
          <Tooltip trigger={<button type="submit">Submit action</button>}>
            Submit hint
          </Tooltip>
        </form>
        <FutureFeatureTooltip locale="cs-CZ">
          <button disabled type="button">
            Unavailable action
          </button>
        </FutureFeatureTooltip>
        <Popover>
          <Tooltip
            trigger={
              <PopoverTrigger asChild>
                <Toggle aria-label="Edit link">Link</Toggle>
              </PopoverTrigger>
            }
          >
            Link hint
          </Tooltip>
          <PopoverContent>
            <input aria-label="Link address" />
          </PopoverContent>
        </Popover>
        <DropdownMenu>
          <Tooltip
            trigger={<DropdownMenuTrigger>Insert value</DropdownMenuTrigger>}
          >
            Value hint
          </Tooltip>
          <DropdownMenuContent>
            <DropdownMenuItem>Customer name</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <output aria-label="Submissions">{submissions}</output>
      </div>
      <div data-testid="outside" style={{ height: 1000 }} />
    </>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
