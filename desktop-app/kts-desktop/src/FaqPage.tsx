import {
  FAQ_CATEGORIES,
  type FaqBlock,
} from "@kety-faq/ketyFaqContent";

function FaqBlockView({ block }: { block: FaqBlock }) {
  switch (block.type) {
    case "p":
      return <p className="faq-block-p">{block.text}</p>;
    case "prose":
      return (
        <p className="faq-block-p">
          {block.parts.map((part, i) => {
            if (part.href) {
              const mailto = part.href.startsWith("mailto:");
              return (
                <a
                  key={i}
                  href={part.href}
                  className="faq-block-p__link"
                  {...(mailto
                    ? {}
                    : { target: "_blank", rel: "noopener noreferrer" })}
                >
                  {part.text}
                </a>
              );
            }
            if (part.bold) {
              return <strong key={i}>{part.text}</strong>;
            }
            return <span key={i}>{part.text}</span>;
          })}
        </p>
      );
    case "h3":
      return <h3 className="faq-block-h3">{block.text}</h3>;
    case "ul":
      return (
        <ul className="faq-block-ul">
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="faq-block-ol">
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      );
    case "links":
      return (
        <div className="faq-block-links">
          {block.items.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {link.label}
            </a>
          ))}
        </div>
      );
    default: {
      const _x: never = block;
      return _x;
    }
  }
}

export function FaqPage() {
  return (
    <div className="faq-page-inner">
      <div className="faq-hero">
        <div className="faq-hero-brand">
          <img
            src="/kts-icon-brand.png"
            alt=""
            width={40}
            height={40}
            className="faq-hero-logo"
          />
          <h1 className="faq-hero-brand-title">FAQ</h1>
        </div>
      </div>

      {FAQ_CATEGORIES.map((category) => (
        <section
          key={category.categoryTitle}
          className="faq-category"
          aria-labelledby={`faq-cat-${slugId(category.categoryTitle)}`}
        >
          <h2
            id={`faq-cat-${slugId(category.categoryTitle)}`}
            className="faq-category__title"
          >
            {category.categoryTitle}
          </h2>
          <div className="faq-accordion">
            {category.sections.map((section, sectionIndex) => (
              <details
                key={`${category.categoryTitle}-${section.title}`}
                className="faq-details"
              >
                <summary className="faq-details__summary">
                  {section.title}
                </summary>
                <div className="faq-details__body">
                  {section.blocks.map((block, i) => (
                    <FaqBlockView
                      key={`${sectionIndex}-${i}`}
                      block={block}
                    />
                  ))}
                </div>
              </details>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function slugId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
