/**
 * Converts known provider plan ids into the product-agnostic tier names used
 * in the tray. Unknown names are deliberately retained: subscription names
 * such as SuperGrok Heavy do not have a safe generic equivalent.
 */
export function canonicalSubscriptionPlanLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const label = value.trim();
  const normalized = label.toLowerCase().replace(/[\s_-]+/g, '');
  const labels: Record<string, string> = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    proplus: 'Pro+',
    professional: 'Pro',
    personalprofessional: 'Pro',
    personalpro: 'Pro',
    max: 'Max',
    max5x: 'Max 5x',
    max20x: 'Max 20x',
    ultra: 'Ultra',
    team: 'Team',
    teams: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu',
    eduplus: 'Edu Plus',
    edupro: 'Edu Pro',
    prolite: 'Pro Lite',
    codingplan: 'Coding Plan',
    starter: 'Starter',
    highspeed: 'HighSpeed',
    lite: 'Lite',
    startplan: 'Start Plan',
    premium: 'Premium',
    googleaipro: 'Pro',
    googleaiultra: 'Ultra',
  };
  return labels[normalized] ?? label;
}

/** Returns the compact plan label that may be shown on a tray card. */
export function trayPlanLabel(value: string | null | undefined): string | null {
  const label = canonicalSubscriptionPlanLabel(value);
  // Free accounts deliberately have no subscription badge.
  return label === 'Free' ? null : label;
}
