// The order of the guide: each chapter leans only on the ones before it.
export interface Chapter {
  slug: string;
  title: string;
  /** The question the chapter answers, as a reader would ask it. */
  question: string;
  minutes: number;
  part: "Fondations" | "Une requête, de bout en bout" | "Ce qui dure" | "Ailleurs";
}

export const chapters: Chapter[] = [
  {
    slug: "carte",
    title: "La carte",
    question: "Quels programmes existent, et qu'est-ce qui les sépare ?",
    minutes: 8,
    part: "Fondations",
  },
  {
    slug: "build",
    title: "Le build",
    question: "Comment un dossier app/ devient-il deux programmes ?",
    minutes: 12,
    part: "Fondations",
  },
  {
    slug: "demarrage",
    title: "Le démarrage",
    question: "Qui lance quoi, et comment le Client trouve-t-il son Server ?",
    minutes: 10,
    part: "Fondations",
  },
  {
    slug: "navigation",
    title: "Une navigation",
    question: "Que se passe-t-il entre un clic sur une note et la note affichée ?",
    minutes: 14,
    part: "Une requête, de bout en bout",
  },
  {
    slug: "server-functions",
    title: "Une Server Function",
    question:
      "Comment un appel de fonction traverse-t-il le réseau, et que sait le Client quand il échoue ?",
    minutes: 12,
    part: "Une requête, de bout en bout",
  },
  {
    slug: "cache",
    title: "Le cache",
    question: "Qu'est-ce qui est mémorisé côté Server, et qui le vide ?",
    minutes: 10,
    part: "Une requête, de bout en bout",
  },
  {
    slug: "session",
    title: "La session",
    question: "Que retrouve l'utilisateur après un crash ou un rebuild ?",
    minutes: 8,
    part: "Ce qui dure",
  },
  {
    slug: "distribution",
    title: "La distribution",
    question: "Comment une app arrive-t-elle sur une autre machine, et qui vérifie quoi ?",
    minutes: 14,
    part: "Ce qui dure",
  },
  {
    slug: "web-desktop",
    title: "Web et desktop",
    question: "Comment la même app tourne-t-elle dans un onglet ou une fenêtre ?",
    minutes: 10,
    part: "Ailleurs",
  },
  {
    slug: "devtools",
    title: "Les DevTools",
    question: "Comment observer tout cela pendant que ça tourne ?",
    minutes: 8,
    part: "Ailleurs",
  },
  {
    slug: "glossaire",
    title: "Glossaire et fichiers",
    question: "Ce mot, ce fichier : où en parle-t-on ?",
    minutes: 5,
    part: "Ailleurs",
  },
];

export const parts = [...new Set(chapters.map((chapter) => chapter.part))];

export function neighbours(slug: string) {
  const index = chapters.findIndex((chapter) => chapter.slug === slug);
  if (index === -1) throw new Error(`Guide : chapitre inconnu ${slug}`);
  return {
    index,
    chapter: chapters[index],
    previous: chapters[index - 1],
    next: chapters[index + 1],
  };
}
