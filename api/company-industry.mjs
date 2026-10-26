import { INDUSTRIES } from './finance-summary.mjs';
import { companyForUser } from './company-members.mjs';

// A business type describes reporting semantics; it must never migrate,
// rename or delete any imported financial operations.
export function setCompanyIndustry(db,actor,industry) {
  if(typeof industry!=='string'||!Object.hasOwn(INDUSTRIES,industry))
    throw Object.assign(Error('Выберите тип бизнеса из списка.'),{status:400});
  db.exec('BEGIN IMMEDIATE');
  try {
    const c=companyForUser(db,actor);
    if(!c||c.access_role!=='owner'||String(c.owner_id)!==String(actor))
      throw Object.assign(Error('Изменять тип бизнеса может только владелец компании.'),{status:403});
    const changed=c.industry!==industry;
    if(changed) {
      db.prepare('UPDATE companies SET industry=? WHERE id=? AND owner_id=?')
        .run(industry,c.id,String(actor));
      // Only cached interpretations are removed; a stale in-flight
      // completion cannot write back an analysis without an active version.
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_analyses'").get())
        db.prepare('DELETE FROM ai_analyses WHERE company_id=?').run(c.id);
    }
    db.exec('COMMIT');
    return {company:{...c,industry},changed};
  }catch(error){db.exec('ROLLBACK');throw error;}
}
